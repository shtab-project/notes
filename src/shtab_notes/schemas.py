"""Schemas of the Notes API."""

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_serializer,
)

Visibility = Literal["private", "shared"]

Title = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)
]


def iso_ms(value: datetime) -> str:
    """UTC time with milliseconds and a `Z`: the format notes are stored in."""
    return (
        value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    )


class NoteIn(BaseModel):
    id: UUID
    title: str = Field(max_length=200)
    body: str
    folder: str
    pinned: bool
    created_at: AwareDatetime
    updated_at: AwareDatetime

    @field_serializer("created_at", "updated_at", when_used="json")
    def serialize_date(self, value: datetime) -> str:
        return iso_ms(value)


@dataclass(frozen=True)
class NoteColumns:
    """A note's own columns, as stored."""

    title: str
    body: str
    folder: str
    pinned: bool
    created_at: str
    updated_at: str

    @classmethod
    def of(cls, note: NoteIn) -> Self:
        return cls(
            title=note.title,
            body=note.body,
            folder=note.folder,
            pinned=note.pinned,
            created_at=iso_ms(note.created_at),
            updated_at=iso_ms(note.updated_at),
        )


class NoteOut(BaseModel):
    """A stored note; times stay the strings the client sent."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    title: str
    body: str
    folder: str
    pinned: bool
    created_at: str
    updated_at: str


class SharedNoteOut(NoteOut):
    published_at: str | None
    author_name: str | None


class NoteSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    title: str
    folder: str
    updated_at: str


class CreatedNote(BaseModel):
    id: UUID
    title: str
    visibility: Visibility


class Changes(BaseModel):
    revision: int = Field(ge=0)
    upsert: list[NoteIn] = Field(default_factory=list)
    delete: list[UUID] = Field(default_factory=list)
    folders: list[str] | None = None


class LegacyNotes(BaseModel):
    notes: list[NoteIn]
    folders: list[str]


class Publish(BaseModel):
    revision: int = Field(ge=0)


@dataclass(frozen=True)
class Health:
    plugin: str
    status: str = "ok"


@dataclass(frozen=True)
class NotesSnapshot:
    revision: int
    folders: list[str]
    notes: list[SharedNoteOut | NoteOut]


@dataclass(frozen=True)
class WorkspaceView(NotesSnapshot):
    """A snapshot plus what the current user may do with it."""

    editable: bool
    can_publish: bool


@dataclass(frozen=True)
class Applied:
    revision: int
    published: dict[UUID, str]


@dataclass(frozen=True)
class Publication:
    author_name: str
    published_at: str


@dataclass(frozen=True)
class Saved:
    revision: int
    metadata: dict[UUID, Publication] | None = None


@dataclass(frozen=True)
class Revision:
    revision: int
