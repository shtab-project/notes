from typing import Annotated
from uuid import UUID

from mcp.types import ToolAnnotations
from pydantic import BaseModel, Field, StringConstraints
from shtab_core.mcp_auth import require_mcp_user_id
from shtab_core.mcp_gateway import PluginTools

from shtab_notes.schemas import NoteIn, Visibility
from shtab_notes.services import NotesService

Title = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)
]


class NoteSummary(BaseModel):
    id: UUID
    title: str
    folder: str
    updated_at: str


class CreatedNote(BaseModel):
    id: UUID
    title: str
    visibility: Visibility


def register_tools(tools: PluginTools) -> None:
    reader = ToolAnnotations(readOnlyHint=True, openWorldHint=False)

    @tools.tool("list", annotations=reader)
    async def list_notes(
        visibility: Visibility = "private",
        query: str = "",
        limit: Annotated[int, Field(ge=1, le=100)] = 20,
    ) -> list[NoteSummary]:
        """Найти заметки по заголовку. Возвращает заголовки и ID без текста."""
        service = NotesService(tools.session_factory())
        entries = await service.list_notes(
            require_mcp_user_id(), visibility, query, limit
        )
        return [NoteSummary.model_validate(entry) for entry in entries]

    @tools.tool("get", annotations=reader)
    async def get_note(note_id: UUID, visibility: Visibility = "private") -> NoteIn:
        """Прочитать заметку по ID из выбранного раздела."""
        service = NotesService(tools.session_factory())
        return NoteIn.model_validate(
            await service.get(require_mcp_user_id(), visibility, note_id)
        )

    @tools.tool(
        "create",
        annotations=ToolAnnotations(
            readOnlyHint=False,
            destructiveHint=False,
            idempotentHint=False,
            openWorldHint=False,
        ),
    )
    async def create_note(title: Title, body: str = "") -> CreatedNote:
        """Создать личную заметку. Текст поддерживает Markdown."""
        service = NotesService(tools.session_factory())
        return CreatedNote.model_validate(
            await service.create_private(require_mcp_user_id(), title, body)
        )
