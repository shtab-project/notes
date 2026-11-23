"""MCP tools of the Notes plugin: find, read and create notes."""

from typing import Annotated
from uuid import UUID

from mcp.types import ToolAnnotations
from pydantic import Field
from shtab_core.mcp_auth import require_mcp_user_id
from shtab_core.mcp_gateway import PluginTools

from shtab_notes.schemas import CreatedNote, NoteOut, NoteSummary, Title, Visibility
from shtab_notes.services import NotesService

READER = ToolAnnotations(read_only_hint=True, open_world_hint=False)
CREATOR = ToolAnnotations(
    read_only_hint=False,
    destructive_hint=False,
    idempotent_hint=False,
    open_world_hint=False,
)


def register_tools(tools: PluginTools) -> None:
    @tools.tool("list", annotations=READER)
    async def list_notes(
        visibility: Visibility = "private",
        query: str = "",
        limit: Annotated[int, Field(ge=1, le=100)] = 20,
    ) -> list[NoteSummary]:
        """Find notes by title. Returns titles and IDs without the text."""
        service = NotesService(tools.session_factory())
        return await service.list_notes(require_mcp_user_id(), visibility, query, limit)

    @tools.tool("get", annotations=READER)
    async def get_note(note_id: UUID, visibility: Visibility = "private") -> NoteOut:
        """Read a note by ID from the chosen section."""
        service = NotesService(tools.session_factory())
        return await service.get(require_mcp_user_id(), visibility, note_id)

    @tools.tool("create", annotations=CREATOR)
    async def create_note(title: Title, body: str = "") -> CreatedNote:
        """Create a private note. The text supports Markdown."""
        service = NotesService(tools.session_factory())
        return await service.create_private(require_mcp_user_id(), title, body)
