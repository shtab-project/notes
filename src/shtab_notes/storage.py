"""Notes in the database: private per user, shared per installation, versioned."""

from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import cast
from uuid import UUID

from fastapi import HTTPException
from shtab_core.models import User
from sqlalchemy import ColumnElement, CursorResult, delete, func, insert, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from shtab_notes.models import NoteEntry, NotesWorkspace
from shtab_notes.schemas import (
    Applied,
    Changes,
    LegacyNotes,
    NoteColumns,
    NoteIn,
    NoteOut,
    NotesSnapshot,
    NoteSummary,
    SharedNoteOut,
    Visibility,
    iso_ms,
)

notes = NoteEntry.metadata.tables[NoteEntry.__tablename__]
workspaces = NotesWorkspace.metadata.tables[NotesWorkspace.__tablename__]
users = User.metadata.tables[User.__tablename__]
# Columns the client sees; ownership and publication are the server's business.
NOTE_COLUMNS = [
    column
    for column in notes.c
    if column.name not in {"owner_id", "visibility", "published_at"}
]


def publication_time() -> str:
    return iso_ms(datetime.now(UTC))


@dataclass
class NotesStorage:
    session: AsyncSession
    user_id: UUID
    visibility: Visibility

    @property
    def key(self) -> str:
        return "shared" if self.visibility == "shared" else str(self.user_id)

    @property
    def scope(self) -> ColumnElement[bool]:
        scope = notes.c.visibility == self.visibility
        if self.visibility == "private":
            scope &= notes.c.owner_id == self.user_id
        return scope

    def _published_at(self) -> str | None:
        return publication_time() if self.visibility == "shared" else None

    async def list_notes(self, query: str, limit: int) -> list[NoteSummary]:
        statement = select(
            notes.c.id, notes.c.title, notes.c.folder, notes.c.updated_at
        ).where(self.scope)
        if query := query.strip():
            statement = statement.where(notes.c.title.icontains(query, autoescape=True))
        rows = await self.session.execute(
            statement.order_by(notes.c.updated_at.desc(), notes.c.id).limit(limit)
        )
        return [NoteSummary.model_validate(row, from_attributes=True) for row in rows]

    async def get(self, note_id: UUID) -> NoteOut | None:
        row = (
            await self.session.execute(
                select(*NOTE_COLUMNS).where(self.scope, notes.c.id == note_id)
            )
        ).one_or_none()
        return NoteOut.model_validate(row, from_attributes=True) if row else None

    async def create(self, note: NoteIn) -> None:
        await self.advance()
        await self.session.execute(
            insert(notes).values(
                id=note.id,
                owner_id=self.user_id,
                visibility=self.visibility,
                published_at=self._published_at(),
                **asdict(NoteColumns.of(note)),
            )
        )

    async def workspace(self) -> NotesWorkspace | None:
        """The workspace row, always re-read: `snapshot` relies on fresh revisions."""
        return await self.session.scalar(
            select(NotesWorkspace)
            .where(NotesWorkspace.key == self.key)
            .execution_options(populate_existing=True)
        )

    async def snapshot(self) -> NotesSnapshot:
        query = select(*NOTE_COLUMNS)
        if self.visibility == "shared":
            author = func.coalesce(
                func.nullif(func.trim(users.c.name), ""), users.c.username
            )
            query = query.add_columns(
                notes.c.published_at, author.label("author_name")
            ).select_from(notes.outerjoin(users, notes.c.owner_id == users.c.id))
        model = SharedNoteOut if self.visibility == "shared" else NoteOut
        state = await self.workspace()
        revision = state.revision if state else 0
        # Re-read until the revision is stable, so notes and folders match.
        while True:
            rows = await self.session.execute(
                query.where(self.scope).order_by(notes.c.updated_at.desc())
            )
            entries = [model.model_validate(row, from_attributes=True) for row in rows]
            latest = await self.workspace()
            latest_revision = latest.revision if latest else 0
            if revision == latest_revision:
                return NotesSnapshot(
                    revision=revision,
                    folders=latest.folders if latest else [],
                    notes=entries,
                )
            revision = latest_revision

    async def advance(
        self, revision: int | None = None, folders: list[str] | None = None
    ) -> None:
        """Bump the revision; with `revision`, only if it is still current."""
        await self.session.execute(
            pg_insert(workspaces)
            .values(key=self.key, revision=0, folders=[], imports=[])
            .on_conflict_do_nothing(index_elements=[workspaces.c.key])
        )
        statement = (
            update(workspaces)
            .where(workspaces.c.key == self.key)
            .values(revision=workspaces.c.revision + 1)
        )
        # 0 is a real revision and [] real folders, so check for None explicitly.
        if revision is not None:
            statement = statement.where(workspaces.c.revision == revision)
        if folders is not None:
            statement = statement.values(folders=folders)
        result = await self.session.execute(statement)
        if not cast(CursorResult, result).rowcount:
            raise HTTPException(
                409, "Notes changed in another tab. Copy your edits before refreshing."
            )

    async def apply(self, changes: Changes) -> Applied:
        await self.advance(changes.revision, changes.folders)
        published: dict[UUID, str] = {}
        if changes.delete:
            await self.session.execute(
                delete(notes).where(self.scope, notes.c.id.in_(changes.delete))
            )
        for note in changes.upsert:
            columns = NoteColumns.of(note)
            result = await self.session.execute(
                update(notes)
                .where(self.scope, notes.c.id == note.id)
                .values(
                    title=columns.title,
                    body=columns.body,
                    folder=columns.folder,
                    pinned=columns.pinned,
                    updated_at=columns.updated_at,
                )
            )
            if cast(CursorResult, result).rowcount:
                continue
            published_at = self._published_at()
            await self.session.execute(
                insert(notes).values(
                    id=note.id,
                    owner_id=self.user_id,
                    visibility=self.visibility,
                    published_at=published_at,
                    **asdict(columns),
                )
            )
            if published_at:
                published[note.id] = published_at
        return Applied(revision=changes.revision + 1, published=published)

    async def import_legacy(self, legacy: LegacyNotes) -> NotesSnapshot:
        await self.advance()
        state = await self.workspace()
        assert state
        imported = set(state.imports)
        for note in legacy.notes:
            key = str(note.id)
            if key in imported:
                continue
            existing = await self.session.scalar(
                select(notes.c.id).where(notes.c.id == note.id)
            )
            if not existing:
                await self.session.execute(
                    insert(notes).values(
                        id=note.id,
                        owner_id=self.user_id,
                        visibility="private",
                        **asdict(NoteColumns.of(note)),
                    )
                )
            imported.add(key)
        await self.session.execute(
            update(workspaces)
            .where(workspaces.c.key == self.key)
            .values(
                imports=sorted(imported),
                folders=list(dict.fromkeys(state.folders + legacy.folders)),
            )
        )
        return await self.snapshot()

    async def publish(self, note_id: UUID, revision: int) -> int:
        await self.advance(revision)
        result = await self.session.execute(
            update(notes)
            .where(self.scope, notes.c.id == note_id)
            .values(
                visibility="shared",
                folder="",
                pinned=False,
                published_at=publication_time(),
            )
        )
        if not cast(CursorResult, result).rowcount:
            raise HTTPException(404, "Private note not found")
        await NotesStorage(self.session, self.user_id, "shared").advance()
        return revision + 1
