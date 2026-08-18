"""SQLModel tables of record.

Scaffold simplification vs. the production schema: parent is an inline
column on Entry rather than a separate FileHierarchy join table. The
adjudication logic only ever touches parent through Entry.parent_id, so
swapping the real schema back in is contained to models + queries.
"""

from __future__ import annotations

from abc import ABC as IsAbstractClass
import enum
from datetime import datetime

from sqlalchemy.dialects.postgresql import JSONB
from sqlmodel import Field, SQLModel, and_

from ...wsfs_suede__sqlmodel_utils_suede.associations import (
    ID,
    WithID,
    WithTime,
    ForeignKeyField,
)
from ...wsfs_suede__sqlmodel_utils_suede.tablenames import tablename, explicit_tablename
from ...wsfs_suede__sqlmodel_utils_suede.columns import EnumField

from .diff import Delta


class User(WithID, tablename("plural"), table=True):
    email: str


class WithUserReference(  # pyright: ignore[reportUnsafeMultipleInheritance]
    SQLModel, IsAbstractClass
):
    user_id: ID = ForeignKeyField(
        User,
        nullable=False,
        description="The id of the user associated with this item.",
        index=True,
    )

    @classmethod
    def MatchToUser(cls):
        return and_(cls.user_id == User.id)


class Workspace(WithID, tablename("plural"), table=True):
    # Internal per-workspace monotonic stream position. Bumped ONLY inside
    # the choke point, under the workspace row lock. Never client-visible.
    position: int = Field(default=0, nullable=False)


class WithWorkspaceReference(  # pyright: ignore[reportUnsafeMultipleInheritance]
    SQLModel, IsAbstractClass
):
    workspace_id: ID = ForeignKeyField(Workspace, nullable=False)
    """The id of the associated workspace."""

    @classmethod
    def MatchToWorkspace(cls):
        return and_(cls.workspace_id == Workspace.id)


class Type(str, enum.Enum):
    FILE = "pending"
    FOLDER = "in progress"


class Entry(
    WithID, WithWorkspaceReference, tablename("custom", "fs_entries"), table=True
):
    """Current state of one tree node (pure namespace — no content plane)."""

    type: Type = EnumField(enum_class=Type)


class WithEntryReference(  # pyright: ignore[reportUnsafeMultipleInheritance]
    SQLModel, IsAbstractClass
):
    entry_id: ID = ForeignKeyField(Entry)

    @classmethod
    def MatchToFileSystem(cls):
        return and_(cls.entry_id == Entry.id)


versions_table = explicit_tablename("Name", "custom", "fs_versions")


class Transaction(  # pyright: ignore[reportUnsafeMultipleInheritance]
    WithID, WithTime, WithUserReference, WithEntryReference, IsAbstractClass
):
    """
    A base class for recording attempts to change a property of an entry.
    In this way, the most recent 'approved' item indicates the current state
    of that entry.

    All denied transactions should be assumed to be relative to that most
    recently approved entry.
    """

    approved: bool = Field(index=True, nullable=False)
    version: ID = ForeignKeyField(versions_table.tablename, nullable=False)
    """
    NOTE: Will point to own ID on creation.
    """


class Name(Transaction, tablename("custom", "fs_names"), table=True):
    name: str = Field(nullable=False)


class Parent(Transaction, tablename("custom", "fs_parentage"), table=True):
    parent_entry_id: ID | None = ForeignKeyField(Entry, nullable=True)


class Deletion(Transaction, tablename("custom", "fs_deletions"), table=True):
    deleted: bool = Field(default=False, nullable=False)


class ContentBase(Transaction, IsAbstractClass):
    size: int = Field(default=0, nullable=False)
    mime: str = Field(default="text/plain", nullable=False)


class TextContent(ContentBase, tablename("custom", "fs_text_content"), table=True):
    delta: Delta = Field(sa_type=JSONB, nullable=False)


class BlobContent(ContentBase, tablename("custom", "fs_blob_content"), table=True):
    hash: str = Field(index=True)


class Version(WithID, WithTime, WithEntryReference, versions_table.mixin, table=True):
    """Immutable snapshot of an entry at one APPROVED version.

    Entries therefore must begin in an approved state.

    Powers (a) CAS-failure reasons (diff presented version vs. current),
    (b) Content fetch by (id, version).
    """

    name_id: ID = ForeignKeyField(table=Name, nullable=False)
    parent_id: ID = ForeignKeyField(Parent, nullable=False)
    deleted_id: ID = ForeignKeyField(Deletion, nullable=False)
    text_content_id: ID | None = ForeignKeyField(TextContent, nullable=True)
    blob_content_id: ID | None = ForeignKeyField(BlobContent, nullable=True)


class WithVersionReference(  # pyright: ignore[reportUnsafeMultipleInheritance]
    SQLModel, IsAbstractClass
):
    version_id: ID = ForeignKeyField(Version, nullable=False)


class StreamToken(SQLModel, table=True):
    token: str = Field(primary_key=True)
    user: str = Field(nullable=False)
    workspace_id: str = Field(nullable=False)
    position: int = Field(nullable=False)  # stream position of the Initialize snapshot
    expires: datetime = Field(nullable=False)


class TextContentCache(WithID, WithEntryReference, WithVersionReference):
    content: str = Field(nullable=False)
