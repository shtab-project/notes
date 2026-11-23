from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from alembic import command
from fastapi import FastAPI
from shtab_core.db import get_session_factory
from shtab_core.dependencies import current_user
from shtab_core.models import User
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from shtab_notes.main import register
from shtab_notes.migrate import migration_config
from shtab_notes.models import NotesWorkspace


@pytest.mark.asyncio
async def test_workspace_read_and_write_transactions():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")

    def migrate(connection):
        User.metadata.tables["users"].create(connection)
        config = migration_config()
        config.attributes["connection"] = connection
        command.upgrade(config, "head")
        command.check(config)

    try:
        async with engine.begin() as connection:
            await connection.run_sync(migrate)

        factory = async_sessionmaker(engine, expire_on_commit=False)
        first, second = uuid4(), uuid4()

        async with factory.begin() as session:
            session.add_all(
                [
                    User(id=first, oidc_sub="first", username="first", name="First"),
                    User(
                        id=second, oidc_sub="second", username="second", name="Second"
                    ),
                ]
            )

        user = SimpleNamespace(id=first, is_admin=False, is_trusted=False)
        app = FastAPI()
        register(app)
        app.dependency_overrides[get_session_factory] = lambda: factory
        app.dependency_overrides[current_user] = lambda: user
        path = "/api/plugins/notes/workspace/private"
        date = "2026-11-18T12:00:00Z"
        note = {
            "id": str(uuid4()),
            "title": "First note",
            "body": "",
            "folder": "",
            "pinned": False,
            "created_at": date,
            "updated_at": date,
        }

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            initial = (await client.get(path)).json()
            assert initial["revision"] == 0
            assert initial["notes"] == []
            async with factory() as session:
                assert (
                    await session.scalar(
                        select(func.count()).select_from(NotesWorkspace)
                    )
                    == 0
                )
            created = await client.patch(path, json={"revision": 0, "upsert": [note]})
            assert created.status_code == 200
            assert (await client.get(path)).json()["notes"][0]["id"] == note["id"]
            user.id = second
            another = {**note, "id": str(uuid4())}
            failed = await client.patch(
                path, json={"revision": 0, "upsert": [another, note]}
            )
            assert failed.status_code == 409
            assert (await client.get(path)).json() == initial
    finally:
        await engine.dispose()
