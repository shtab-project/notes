"""Pins the Notes HTTP and MCP behavior: response shapes, permissions, revisions."""

from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
from alembic import command
from fastapi import FastAPI
from mcp.server.mcpserver.exceptions import ToolError
from shtab_core.db import get_session_factory
from shtab_core.dependencies import current_user
from shtab_core.models import User
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from shtab_notes.main import register
from shtab_notes.migrate import migration_config
from shtab_notes.services import NotesService

PRIVATE = "/api/plugins/notes/workspace/private"
SHARED = "/api/plugins/notes/workspace/shared"
NOTE_KEYS = {"id", "title", "body", "folder", "pinned", "created_at", "updated_at"}
DATE = "2026-11-18T12:00:00.000Z"
ALICE, BOB = uuid4(), uuid4()


def note(title: str = "Note", **fields: object) -> dict[str, object]:
    return {
        "id": str(uuid4()),
        "title": title,
        "body": "",
        "folder": "",
        "pinned": False,
        "created_at": DATE,
        "updated_at": DATE,
        **fields,
    }


@pytest_asyncio.fixture
async def env():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")

    def migrate(connection):
        User.metadata.tables["users"].create(connection)
        config = migration_config()
        config.attributes["connection"] = connection
        command.upgrade(config, "head")

    async with engine.begin() as connection:
        await connection.run_sync(migrate)

    factory = async_sessionmaker(engine, expire_on_commit=False)

    async with factory.begin() as session:
        session.add_all(
            [
                User(id=ALICE, oidc_sub="alice", username="alice", name="Alice"),
                User(id=BOB, oidc_sub="bob", username="bob", name="  "),
            ]
        )

    user = SimpleNamespace(
        id=ALICE, name="Alice", username="alice", is_admin=False, is_trusted=True
    )
    app = FastAPI()
    register(app)
    app.dependency_overrides[get_session_factory] = lambda: factory
    app.dependency_overrides[current_user] = lambda: user

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        yield SimpleNamespace(client=client, user=user, factory=factory)

    await engine.dispose()


async def test_private_snapshot_shape(env):
    state = (await env.client.get(PRIVATE)).json()
    assert state == {
        "revision": 0,
        "folders": [],
        "notes": [],
        "editable": True,
        "can_publish": True,
    }
    env.user.is_trusted = False
    state = (await env.client.get(SHARED)).json()
    assert state["editable"] is False and state["can_publish"] is False


async def test_save_creates_updates_deletes_and_sets_folders(env):
    first, second = note("First", folder="Work"), note("Second")
    saved = await env.client.patch(
        PRIVATE, json={"revision": 0, "upsert": [first, second], "folders": ["Work"]}
    )
    assert saved.json() == {"revision": 1}

    state = (await env.client.get(PRIVATE)).json()
    assert state["revision"] == 1 and state["folders"] == ["Work"]
    assert all(set(item) == NOTE_KEYS for item in state["notes"])
    assert {item["title"] for item in state["notes"]} == {"First", "Second"}

    changed = {**first, "body": "text", "created_at": "2030-01-01T00:00:00.000Z"}
    saved = await env.client.patch(
        PRIVATE, json={"revision": 1, "upsert": [changed], "delete": [second["id"]]}
    )
    assert saved.json() == {"revision": 2}
    state = (await env.client.get(PRIVATE)).json()
    assert state["folders"] == ["Work"]
    assert [item["id"] for item in state["notes"]] == [first["id"]]
    assert state["notes"][0]["body"] == "text"
    assert state["notes"][0]["created_at"] == DATE


async def test_stale_revision_is_a_conflict(env):
    await env.client.patch(PRIVATE, json={"revision": 0, "upsert": [note()]})
    stale = await env.client.patch(PRIVATE, json={"revision": 0, "upsert": [note()]})
    assert stale.status_code == 409


async def test_shared_notes_carry_author_and_publication(env):
    created = note("Team")
    saved = (
        await env.client.patch(SHARED, json={"revision": 0, "upsert": [created]})
    ).json()
    assert saved["revision"] == 1
    assert set(saved["metadata"]) == {created["id"]}
    assert saved["metadata"][created["id"]]["author_name"] == "Alice"
    published_at = saved["metadata"][created["id"]]["published_at"]

    entry = (await env.client.get(SHARED)).json()["notes"][0]
    assert set(entry) == NOTE_KEYS | {"published_at", "author_name"}
    assert entry["author_name"] == "Alice" and entry["published_at"] == published_at

    edited = await env.client.patch(
        SHARED, json={"revision": 1, "upsert": [{**created, "body": "more"}]}
    )
    assert edited.json() == {"revision": 2}


async def test_author_name_falls_back_to_username(env):
    env.user.id, env.user.name, env.user.username = BOB, "  ", "bob"
    created = note()
    saved = (
        await env.client.patch(SHARED, json={"revision": 0, "upsert": [created]})
    ).json()
    assert saved["metadata"][created["id"]]["author_name"] == "bob"
    entry = (await env.client.get(SHARED)).json()["notes"][0]
    assert entry["author_name"] == "bob"


async def test_only_trusted_users_edit_shared_notes(env):
    env.user.is_trusted = False
    denied = await env.client.patch(SHARED, json={"revision": 0, "upsert": [note()]})
    assert denied.status_code == 403


async def test_publish_moves_a_private_note_to_shared(env):
    private = note("Draft", folder="Work", pinned=True)
    await env.client.patch(PRIVATE, json={"revision": 0, "upsert": [private]})

    published = await env.client.post(
        f"/api/plugins/notes/{private['id']}/publish", json={"revision": 1}
    )
    assert published.json() == {"revision": 2}
    assert (await env.client.get(PRIVATE)).json()["notes"] == []
    shared = (await env.client.get(SHARED)).json()
    assert shared["revision"] == 1
    entry = shared["notes"][0]
    assert entry["id"] == private["id"]
    assert entry["folder"] == "" and entry["pinned"] is False
    assert entry["published_at"] and entry["author_name"] == "Alice"

    missing = await env.client.post(
        f"/api/plugins/notes/{uuid4()}/publish", json={"revision": 2}
    )
    assert missing.status_code == 404
    stale = await env.client.post(
        f"/api/plugins/notes/{private['id']}/publish", json={"revision": 0}
    )
    assert stale.status_code == 409
    env.user.is_trusted = False
    denied = await env.client.post(
        f"/api/plugins/notes/{private['id']}/publish", json={"revision": 2}
    )
    assert denied.status_code == 403


async def test_import_legacy_is_idempotent_and_merges_folders(env):
    await env.client.patch(PRIVATE, json={"revision": 0, "folders": ["Home"]})
    legacy = note("Old")
    payload = {"notes": [legacy], "folders": ["Work", "Home"]}

    imported = (await env.client.post("/api/plugins/notes/import", json=payload)).json()
    assert set(imported) == {"revision", "folders", "notes"}
    assert imported["folders"] == ["Home", "Work"]
    assert [item["id"] for item in imported["notes"]] == [legacy["id"]]

    again = (
        await env.client.post(
            "/api/plugins/notes/import",
            json={"notes": [{**legacy, "title": "Changed"}], "folders": []},
        )
    ).json()
    assert [item["title"] for item in again["notes"]] == ["Old"]


async def test_mcp_service_lists_reads_and_creates(env):
    service = NotesService(env.factory)
    created = await service.create_private(ALICE, "Idea", "body")
    assert (created.title, created.visibility) == ("Idea", "private")
    listed = await service.list_notes(ALICE, "private", "ide", 10)
    assert [item.id for item in listed] == [created.id]
    assert set(listed[0].model_dump()) == {"id", "title", "folder", "updated_at"}
    read = await service.get(ALICE, "private", created.id)
    assert read.body == "body"
    assert await service.list_notes(BOB, "private", "", 10) == []
    with pytest.raises(ToolError, match="Note not found"):
        await service.get(BOB, "private", created.id)
