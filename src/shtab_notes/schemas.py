from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, Field, field_serializer

Visibility = Literal["private", "shared"]


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
        return (
            value.astimezone(UTC)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )

    def columns(self) -> dict:
        return self.model_dump(mode="json", exclude={"id"})


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
