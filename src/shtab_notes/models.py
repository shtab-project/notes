from uuid import UUID

from shtab_core.models import User
from sqlalchemy import JSON, CheckConstraint, ForeignKey, String, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class NotesWorkspace(Base):
    __tablename__ = "notes_workspaces"

    key: Mapped[str] = mapped_column(String(36), primary_key=True)
    revision: Mapped[int]
    folders: Mapped[list[str]] = mapped_column(JSON)
    imports: Mapped[list[str]] = mapped_column(JSON)


class NoteEntry(Base):
    __tablename__ = "notes_entries"
    __table_args__ = (
        CheckConstraint(
            "visibility IN ('private', 'shared')", name="ck_notes_visibility"
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True)
    owner_id: Mapped[UUID] = mapped_column(
        ForeignKey(User.__table__.c.id, ondelete="RESTRICT"), index=True
    )
    visibility: Mapped[str] = mapped_column(String(7), index=True)
    title: Mapped[str] = mapped_column(String(200))
    folder: Mapped[str] = mapped_column(Text)
    body: Mapped[str] = mapped_column(Text)
    pinned: Mapped[bool]
    created_at: Mapped[str] = mapped_column(String(40))
    updated_at: Mapped[str] = mapped_column(String(40))
    published_at: Mapped[str | None] = mapped_column(String(40))
