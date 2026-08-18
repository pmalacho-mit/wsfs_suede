# pyright: reportUnsafeMultipleInheritance=false

"""SQLModel tables of record.

An entry is pure identity. Its name, its parent, its deletion and its content
each live in their own append-only table, and a `Version` names one
combination of those four. Current state is therefore not a row anyone
overwrites -- it is the newest combination -- so history costs nothing extra
and the log cannot drift from the truth.

Only transactions that were applied are recorded. A refused one changed
nothing, so there is nothing to store: presenting it again re-runs the same
adjudication and produces the same reason (see `service.refusal`).

A `Version` is also the stream event that produced it: one approved mutation
appends exactly one version, at exactly one workspace position. There is no
separate event table to keep in sync.
"""

from __future__ import annotations

from abc import ABC as IsAbstractClass
import enum
from datetime import datetime

from sqlalchemy import CheckConstraint, Index, UniqueConstraint, TIMESTAMP
from sqlalchemy.dialects.postgresql import JSONB
from sqlmodel import Field, SQLModel

# Imported for the side effect: it swaps SQLModel.metadata for one carrying the
# library's naming convention. Must land before any table model is defined.
from wsfs_suede__sqlmodel_utils_suede import (
    metadata as _naming_convention,  # pyright: ignore[reportUnusedImport]
)
from wsfs_suede__sqlmodel_utils_suede.associations import (
    ID,
    WithID,
    WithTime,
    ForeignKeyField,
)
from wsfs_suede__sqlmodel_utils_suede.columns import EnumField
from wsfs_suede__sqlmodel_utils_suede.tablenames import tablename, explicit_tablename

from .diff import Delta


class User(WithID, tablename("plural"), table=True):
    email: str = Field(index=True, unique=True, nullable=False)


class WithUserReference(  # pyright: ignore[reportUnsafeMultipleInheritance]
    SQLModel, IsAbstractClass
):
    user_id: ID = ForeignKeyField(
        User,
        nullable=False,
        description="The id of the user associated with this item.",
    )


class Workspace(WithID, tablename("plural"), table=True):
    # Internal per-workspace monotonic stream position. Bumped ONLY inside
    # the choke point, under the workspace row lock. Never client-visible.
    position: int = Field(default=0, nullable=False)


class WithWorkspaceReference(  # pyright: ignore[reportUnsafeMultipleInheritance]
    SQLModel, IsAbstractClass
):
    workspace_id: ID = ForeignKeyField(Workspace, nullable=False)
    """The id of the associated workspace."""


class Type(str, enum.Enum):
    FILE = "file"
    FOLDER = "folder"


class Entry(
    WithID, WithWorkspaceReference, tablename("custom", "fs_entries"), table=True
):
    """One tree node's identity. Everything mutable about it is versioned."""

    type: Type = EnumField(Type, name="fs_entry_type")


class WithEntryReference(SQLModel, IsAbstractClass):
    entry_id: ID = ForeignKeyField(Entry)


class Transaction(
    WithID, WithTime, WithUserReference, WithEntryReference, IsAbstractClass
):
    """One applied change to one property of one entry.

    Finding a client's transaction id here is the whole of dedup: the change
    it names already happened, so presenting it again is answered rather than
    applied a second time.
    """

    transaction: str = Field(index=True, unique=True, nullable=False)
    """Client-minted `${client}:${counter}` -- the dedup key."""


class Name(Transaction, tablename("custom", "fs_names"), table=True):
    name: str = Field(nullable=False)


class Parent(Transaction, tablename("custom", "fs_parentage"), table=True):
    parent_entry_id: ID | None = ForeignKeyField(Entry, nullable=True)
    """Absent means the workspace root."""


class Deletion(Transaction, tablename("custom", "fs_deletions"), table=True):
    deleted: bool = Field(default=False, nullable=False)


class Content(Transaction, IsAbstractClass):
    size: int = Field(default=0, nullable=False)
    mime: str = Field(default="text/plain", nullable=False)


class TextContent(Content, tablename("custom", "fs_text_content"), table=True):
    delta: Delta = Field(sa_type=JSONB, nullable=False)
    """How this version's text differs from the entry's previous text."""


class BlobContent(Content, tablename("custom", "fs_blob_content"), table=True):
    hash: str = Field(index=True, nullable=False)


class Event(str, enum.Enum):
    CREATE = "create"
    NAME = "name"
    PARENT = "parent"
    DELETE = "delete"
    WRITE = "write"


versions_table = explicit_tablename("Version", "custom", "fs_versions")


class Version(WithID, WithTime, WithEntryReference, versions_table.mixin, table=True):
    """One approved state of an entry, and the stream event that produced it.

    Powers (a) the CAS token clients present, (b) Content fetch by
    (entry, version), (c) the event stream -- replay is this table, ordered
    by position, so the log is the truth rather than a copy of it.
    """

    position: int = Field(index=True, nullable=False)
    """The workspace stream position this version was committed at."""

    event: Event = EnumField(Event, name="fs_event")
    """Which of the pointers below this version introduced."""

    name_id: ID = ForeignKeyField(Name)
    parent_id: ID = ForeignKeyField(Parent)
    deleted_id: ID = ForeignKeyField(Deletion)
    text_content_id: ID | None = ForeignKeyField(TextContent, nullable=True)
    blob_content_id: ID | None = ForeignKeyField(BlobContent, nullable=True)

    __table_args__ = (
        CheckConstraint(
            "num_nonnulls(text_content_id, blob_content_id) <= 1",
            name="one_content_kind",
        ),
        Index(f"ix_{versions_table.tablename}_entry_position", "entry_id", "position"),
    )


class TextContentCache(
    WithID, WithEntryReference, tablename("custom", "fs_text_cache"), table=True
):
    """Derived, never authoritative: one entry's text at one version.

    Reconstruction folds deltas, which is linear in an entry's history. This
    row anchors the fold at the newest version so the common read is free and
    older versions are recovered by inverting a few deltas backwards.
    Deleting the whole table only costs time.
    """

    version_id: ID = ForeignKeyField(Version)
    content: str = Field(nullable=False)

    __table_args__ = (UniqueConstraint("entry_id"),)


class StreamToken(
    WithUserReference,
    WithWorkspaceReference,
    tablename("custom", "fs_stream_tokens"),
    table=True,
):
    """Single-use, position-bound credential minted by Initialize."""

    token: str = Field(primary_key=True)
    position: int = Field(nullable=False)
    expires: datetime = Field(sa_type=TIMESTAMP(timezone=True), nullable=False)
