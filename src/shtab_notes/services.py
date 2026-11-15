from datetime import UTC, datetime
from uuid import UUID, uuid4

from mcp.server.mcpserver.exceptions import ToolError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from shtab_notes.schemas import NoteIn, Visibility
from shtab_notes.storage import NotesStorage


class NotesService:
    def __init__(self, factory: async_sessionmaker[AsyncSession]) -> None:
        self.factory = factory

    async def list_notes(
        self, user_id: UUID, visibility: Visibility, query: str, limit: int
    ) -> list[dict]:
        async with self.factory() as session:
            return await NotesStorage(session, user_id, visibility).list_notes(
                query, limit
            )

    async def get(self, user_id: UUID, visibility: Visibility, note_id: UUID) -> dict:
        async with self.factory() as session:
            note = await NotesStorage(session, user_id, visibility).get(note_id)
        if note is None:
            raise ToolError("Заметка не найдена")
        return note

    async def create_private(self, user_id: UUID, title: str, body: str) -> dict:
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
        return {"id": str(note.id), "title": note.title, "visibility": "private"}
