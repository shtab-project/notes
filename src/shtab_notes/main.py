"""Mounts the Notes routes into the core FastAPI app."""

from uuid import UUID

from fastapi import APIRouter, FastAPI, HTTPException
from shtab_core.dependencies import CurrentUser
from shtab_core.models import User
from sqlalchemy.exc import IntegrityError

from shtab_notes.dependencies import ReadSession, WriteSession
from shtab_notes.schemas import (
    Changes,
    Health,
    LegacyNotes,
    NotesSnapshot,
    Publication,
    Publish,
    Revision,
    Saved,
    Visibility,
    WorkspaceView,
)
from shtab_notes.storage import NotesStorage

router = APIRouter(prefix="/api/plugins/notes", tags=["notes"])


def can_edit_shared(user: User) -> bool:
    return user.is_admin or user.is_trusted


@router.get("/health", response_model=Health)
async def health(_: CurrentUser):
    return Health(plugin="notes")


@router.get("/workspace/{visibility}", response_model=WorkspaceView)
async def workspace(visibility: Visibility, user: CurrentUser, session: ReadSession):
    snapshot = await NotesStorage(session, user.id, visibility).snapshot()
    return WorkspaceView(
        revision=snapshot.revision,
        folders=snapshot.folders,
        notes=snapshot.notes,
        editable=visibility == "private" or can_edit_shared(user),
        can_publish=can_edit_shared(user),
    )


@router.patch(
    "/workspace/{visibility}", response_model=Saved, response_model_exclude_none=True
)
async def save(
    visibility: Visibility, changes: Changes, user: CurrentUser, session: WriteSession
):
    if visibility == "shared" and not can_edit_shared(user):
        raise HTTPException(403, "Shared notes are read-only")
    try:
        applied = await NotesStorage(session, user.id, visibility).apply(changes)
    except IntegrityError as exc:
        raise HTTPException(
            409, "Could not save the changes. Copy your edits before refreshing."
        ) from exc
    if not applied.published:
        return Saved(revision=applied.revision)
    author_name = user.name.strip() or user.username
    return Saved(
        revision=applied.revision,
        metadata={
            note_id: Publication(author_name=author_name, published_at=published_at)
            for note_id, published_at in applied.published.items()
        },
    )


@router.post("/import", response_model=NotesSnapshot)
async def import_legacy(legacy: LegacyNotes, user: CurrentUser, session: WriteSession):
    return await NotesStorage(session, user.id, "private").import_legacy(legacy)


@router.post("/{note_id}/publish", response_model=Revision)
async def publish(
    note_id: UUID, payload: Publish, user: CurrentUser, session: WriteSession
):
    if not can_edit_shared(user):
        raise HTTPException(403, "Only admins and trusted users can publish notes")
    storage = NotesStorage(session, user.id, "private")
    return Revision(revision=await storage.publish(note_id, payload.revision))


def register(app: FastAPI) -> None:
    app.include_router(router)
