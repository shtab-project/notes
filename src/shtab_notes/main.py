from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, FastAPI, HTTPException
from shtab_core.db import get_session_factory
from shtab_core.dependencies import CurrentUser
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from shtab_notes.schemas import Changes, LegacyNotes, Publish, Visibility
from shtab_notes.storage import NotesStorage

router = APIRouter(prefix="/api/plugins/notes", tags=["notes"])
SessionFactory = Annotated[
    async_sessionmaker[AsyncSession], Depends(get_session_factory)
]


def can_edit_shared(user: CurrentUser) -> bool:
    return user.is_admin or user.is_trusted


@router.get("/health")
async def health(_: CurrentUser):
    return {"plugin": "notes", "status": "ok"}


@router.get("/workspace/{visibility}")
async def workspace(visibility: Visibility, user: CurrentUser, factory: SessionFactory):
    async with factory.begin() as session:
        snapshot = await NotesStorage(session, user.id, visibility).snapshot()
        return {
            **snapshot,
            "editable": visibility == "private" or can_edit_shared(user),
            "can_publish": can_edit_shared(user),
        }


@router.patch("/workspace/{visibility}")
async def save(
    visibility: Visibility, changes: Changes, user: CurrentUser, factory: SessionFactory
):
    if visibility == "shared" and not can_edit_shared(user):
        raise HTTPException(403, "Общие заметки доступны только для чтения")
    try:
        async with factory.begin() as session:
            result = await NotesStorage(session, user.id, visibility).apply(changes)
    except IntegrityError as exc:
        raise HTTPException(
            409, "Не удалось сохранить изменения. Скопируйте правки перед обновлением."
        ) from exc
    published = result.pop("published")
    if published:
        author_name = user.name.strip() or user.username
        result["metadata"] = {
            note_id: {"author_name": author_name, "published_at": published_at}
            for note_id, published_at in published.items()
        }
    return result


@router.post("/import")
async def import_legacy(
    legacy: LegacyNotes, user: CurrentUser, factory: SessionFactory
):
    async with factory.begin() as session:
        return await NotesStorage(session, user.id, "private").import_legacy(legacy)


@router.post("/{note_id}/publish")
async def publish(
    note_id: UUID, payload: Publish, user: CurrentUser, factory: SessionFactory
):
    if not can_edit_shared(user):
        raise HTTPException(
            403, "Публиковать заметки могут администратор и доверенные пользователи"
        )
    async with factory.begin() as session:
        revision = await NotesStorage(session, user.id, "private").publish(
            note_id, payload.revision
        )
    return {"revision": revision}


def register(app: FastAPI) -> None:
    app.include_router(router)
