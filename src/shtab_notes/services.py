"""Note scenarios for the MCP tools."""

from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID, uuid4

from mcp.server.mcpserver.exceptions import ToolError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from shtab_notes.schemas import CreatedNote, NoteIn, NoteOut, NoteSummary, Visibility
from shtab_notes.storage import NotesStorage


@dataclass
class NotesService:
    factory: async_sessionmaker[AsyncSession]

    async def list_notes(
        self, user_id: UUID, visibility: Visibility, query: str, limit: int
    ) -> list[NoteSummary]:
        async with self.factory() as session:
            return await NotesStorage(session, user_id, visibility).list_notes(
                query, limit
            )

    async def get(
        self, user_id: UUID, visibility: Visibility, note_id: UUID
    ) -> NoteOut:
        async with self.factory() as session:
            note = await NotesStorage(session, user_id, visibility).get(note_id)

        if not note:
            raise ToolError("Note not found")
        return note

    async def create_private(self, user_id: UUID, title: str, body: str) -> CreatedNote:
        now = datetime.now(UTC)
        note = NoteIn(
            id=uuid4(),
            title=title,
            body=body,
            folder="",
            pinned=False,
            created_at=now,
            updated_at=now,
        )

        async with self.factory.begin() as session:
            await NotesStorage(session, user_id, "private").create(note)

        return CreatedNote(id=note.id, title=note.title, visibility="private")
