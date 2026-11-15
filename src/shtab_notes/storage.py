from datetime import UTC, datetime
from uuid import UUID

from fastapi import HTTPException
from shtab_core.models import User
from sqlalchemy import delete, func, insert, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from shtab_notes.models import notes, workspaces
from shtab_notes.schemas import Changes, LegacyNotes, NoteIn


class NotesStorage:
    def __init__(self, session: AsyncSession, user_id: UUID, visibility: str):
        self.session = session
        self.user_id = user_id
        self.visibility = visibility
        self.key = "shared" if visibility == "shared" else str(user_id)
        self.scope = notes.c.visibility == visibility
        if visibility == "private":
            self.scope &= notes.c.owner_id == user_id

    async def list_notes(self, query: str, limit: int) -> list[dict]:
        statement = select(
            notes.c.id, notes.c.title, notes.c.folder, notes.c.updated_at
        ).where(self.scope)
        if query := query.strip():
            statement = statement.where(notes.c.title.icontains(query, autoescape=True))
        rows = (
            await self.session.execute(
                statement.order_by(notes.c.updated_at.desc(), notes.c.id).limit(limit)
            )
        ).mappings()
        return [dict(row) for row in rows]

    async def get(self, note_id: UUID) -> dict | None:
        columns = [
            column
            for column in notes.c
            if column.name not in {"owner_id", "visibility", "published_at"}
        ]
        row = (
            (
                await self.session.execute(
                    select(*columns).where(self.scope, notes.c.id == note_id)
                )
            )
            .mappings()
            .one_or_none()
        )
        return dict(row) if row else None

    async def create(self, note: NoteIn) -> None:
        await self.advance()
        await self.session.execute(
            insert(notes).values(
                id=note.id,
                owner_id=self.user_id,
                visibility=self.visibility,
                **note.columns(),
                published_at=publication_time()
                if self.visibility == "shared"
                else None,
            )
        )

    async def workspace(self):
        query = select(workspaces).where(workspaces.c.key == self.key)
        row = (await self.session.execute(query)).mappings().one_or_none()
        if row is None:
            try:
                async with self.session.begin_nested():
                    await self.session.execute(
                        insert(workspaces).values(
                            key=self.key, revision=0, folders=[], imports=[]
                        )
                    )
            except IntegrityError:
                # A concurrent first visit may have initialized this workspace.
                pass
            row = (await self.session.execute(query)).mappings().one()
        return row

    async def snapshot(self) -> dict:
        columns = [
            column
            for column in notes.c
            if column.name not in {"owner_id", "visibility", "published_at"}
        ]
        query = select(*columns)
        if self.visibility == "shared":
            users = User.__table__
            author = func.coalesce(
                func.nullif(func.trim(users.c.name), ""), users.c.username
            )
            query = query.add_columns(notes.c.published_at, author.label("author_name"))
            query = query.select_from(
                notes.outerjoin(users, notes.c.owner_id == users.c.id)
            )
        state = await self.workspace()
        while True:
            entries = (
                (
                    await self.session.execute(
                        query.where(self.scope).order_by(notes.c.updated_at.desc())
                    )
                )
                .mappings()
                .all()
            )
            latest = await self.workspace()
            if state["revision"] == latest["revision"]:
                return {
                    "revision": state["revision"],
                    "folders": state["folders"],
                    "notes": [dict(entry) for entry in entries],
                }
            state = latest

    async def advance(self, revision: int | None = None, **values) -> None:
        await self.workspace()
        statement = update(workspaces).where(workspaces.c.key == self.key)
        if revision is not None:
            statement = statement.where(workspaces.c.revision == revision)
        result = await self.session.execute(
            statement.values(revision=workspaces.c.revision + 1, **values)
        )
        if not result.rowcount:
            raise HTTPException(
                409,
                "Заметки изменились в другой вкладке. Скопируйте свои правки перед обновлением.",
            )

    async def apply(self, changes: Changes) -> dict:
        folders = {} if changes.folders is None else {"folders": changes.folders}
        await self.advance(changes.revision, **folders)
        published = {}
        if changes.delete:
            await self.session.execute(
                delete(notes).where(self.scope, notes.c.id.in_(changes.delete))
            )
        for note in changes.upsert:
            values = note.columns()
            result = await self.session.execute(
                update(notes)
                .where(self.scope, notes.c.id == note.id)
                .values(
                    **{
                        key: value
                        for key, value in values.items()
                        if key != "created_at"
                    }
                )
            )
            if not result.rowcount:
                published_at = (
                    publication_time() if self.visibility == "shared" else None
                )
                await self.session.execute(
                    insert(notes).values(
                        id=note.id,
                        owner_id=self.user_id,
                        visibility=self.visibility,
                        published_at=published_at,
                        **values,
                    )
                )
                if published_at:
                    published[str(note.id)] = published_at
        return {"revision": changes.revision + 1, "published": published}

    async def import_legacy(self, legacy: LegacyNotes) -> dict:
        await self.advance()
        state = await self.workspace()
        imported = set(state["imports"])
        for note in legacy.notes:
            key = str(note.id)
            if key in imported:
                continue
            existing = await self.session.scalar(
                select(notes.c.id).where(notes.c.id == note.id)
            )
            if existing is None:
                await self.session.execute(
                    insert(notes).values(
                        id=note.id,
                        owner_id=self.user_id,
                        visibility="private",
                        **note.columns(),
                    )
                )
            imported.add(key)
        await self.session.execute(
            update(workspaces)
            .where(workspaces.c.key == self.key)
            .values(
                imports=sorted(imported),
                folders=list(dict.fromkeys(state["folders"] + legacy.folders)),
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
        if not result.rowcount:
            raise HTTPException(404, "Личная заметка не найдена")
        await NotesStorage(self.session, self.user_id, "shared").advance()
        return revision + 1


def publication_time() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
