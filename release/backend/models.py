"""SQLModel tables of record, built against a host schema.

An entry is pure identity. Its name, its parent, its deletion and its content
each live in their own append-only table, and each row records the workspace
position it landed at. Current state is therefore not a row anyone overwrites
-- it is the newest row per property -- so history costs nothing extra and the
log cannot drift from the truth.

Identity is minted by the client, and one identifier does three jobs: the id
of a transaction is the primary key of the row it applies, the dedup key that
makes a retry free, and the CAS token the next mutation of that property must
present. A client can therefore predict the token its own work will produce,
which is what lets it compose a whole session's work offline.

Only transactions that were applied are recorded. A refused one changed
nothing, so there is nothing to store: presenting it again re-runs the same
adjudication and produces the same reason (see `service.refusal`).

These rows are also the event stream: one applied transaction takes exactly
one position, and which table its rows are in IS which event it was. There is
nothing else to write, and so nothing that can disagree.

NOTHING HERE IS A MODULE-LEVEL TABLE. A foreign key names its target table in
the field itself, so a table pointing at somebody else's users cannot exist
until somebody says which table that is -- which is why `build_models` creates
the classes rather than a mixin decorating them. What this package owns is the
shape; the host owns identity, and hands over two table names.
"""

from __future__ import annotations

from abc import ABC as IsAbstractClass
import enum
import warnings
from dataclasses import dataclass
from datetime import datetime
from typing import Any, ClassVar, cast, final

from sqlalchemy import CheckConstraint, Index, UniqueConstraint, TIMESTAMP
from sqlalchemy.sql.schema import SchemaItem
from sqlalchemy.types import TypeEngine
from sqlalchemy.dialects.postgresql import JSONB
from sqlmodel import Field, SQLModel

from ...wsfs_suede__sqlmodel_utils_suede.associations import (
    ID,
    WithID,
    WithTime,
    ForeignKeyField,
    WithTableName,
    get_tablename,
)
from ...wsfs_suede__sqlmodel_utils_suede.columns import EnumField
from ...wsfs_suede__sqlmodel_utils_suede.tablenames import tablename

from .diff import Delta

DEFAULT_PREFIX = "wsfs"


class Minted(SQLModel, IsAbstractClass):  # pyright: ignore[reportUnsafeMultipleInheritance]
    """A row whose id whoever originated the transaction chose.

    Almost always the client, so that it can predict its own tokens; the
    controller mints one for the work it issues itself.

    Deliberately no default. An id nobody chose on purpose is one no client
    will recognise, so a call site that forgets to pass one has to fail at
    construction rather than quietly diverge.
    """

    id: ID = Field(primary_key=True, index=True, nullable=False)


UNSTAMPED = 0


class Positioned(SQLModel, IsAbstractClass):  # pyright: ignore[reportUnsafeMultipleInheritance]
    position: int = Field(default=UNSTAMPED, index=True, nullable=False)
    """Where this landed in its workspace's one ordered stream.

    Stamped by the choke point and nowhere else. The default is the unstamped
    value precisely so that a row which bypassed it cannot reach the database:
    positions start at one.
    """


class Type(str, enum.Enum):
    FILE = "file"
    FOLDER = "folder"


# -- the shapes ----------------------------------------------------------------
#
# Every field is declared here, where it can be read and typed. What `build`
# adds is only what cannot be known until a host speaks up: which table an id
# refers to, and what these tables are called.


class EntryRow(Minted, IsAbstractClass):
    """One tree node's identity. Everything mutable about it is versioned."""

    workspace_id: ID
    type: Type


class TransactionRow(Minted, Positioned, WithTime, IsAbstractClass):
    """One applied change to one property of one entry.

    Finding a client's transaction id here is the whole of dedup: the change
    it names already happened, so presenting it again is answered rather than
    applied a second time. It is also the property's current CAS token.

    TWO CLOCKS, ONE NEW COLUMN. `timestamp`, from `WithTime`, is this server's
    -- stamped as the row is applied, and the only time here anybody has a
    reason to believe. The client's is already in `id`: a UUIDv7 carries the
    millisecond it was minted, which is the moment the user acted, and
    `minted.minted_at` reads it back out. Storing that in a column beside the
    primary key would be storing the key's own contents twice, where the two
    can drift. What is genuinely NOT derivable is which clock the client was
    reading, and that is the one thing added below.
    """

    entry_id: ID
    user_id: ID

    utc_offset: int | None = Field(default=None, nullable=True)
    """The client's minutes east of UTC when it minted `id`, or null if it did
    not say.

    Not a timezone name. A name would survive a rule change -- Samoa crossing
    the date line, a country abolishing DST -- and would be the better thing to
    store for a time still to come. This is a past one, and for a past instant
    the offset IS the answer: it is what the clock said, whatever any database
    of rules later decides it should have said.
    """


class NameRow(TransactionRow, IsAbstractClass):
    name: str = Field(nullable=False)


class ParentRow(TransactionRow, IsAbstractClass):
    parent_entry_id: ID | None
    """Absent means the workspace root."""


class DeletionRow(TransactionRow, IsAbstractClass):
    deleted: bool = Field(default=False, nullable=False)
    """Stated, not implied by the row's existence.

    A create appends `False` here, which is what gives a newborn entry a
    deletion token to present -- the same shape as its other three, so nothing
    special-cases "not deleted yet". The field being a flag rather than the
    row being a tombstone also means restoring an entry would be an ordinary
    append of `False`, judged like any other transaction. NOTHING IN THE
    CONTRACT DOES THAT TODAY: `delete` is the only operation that writes here
    and it only ever writes `True`. The field anticipates restore; it does not
    implement it.
    """


class ContentRow(TransactionRow, IsAbstractClass):
    size: int = Field(default=0, nullable=False)
    mime: str = Field(default="text/plain", nullable=False)


class TextContentRow(ContentRow, IsAbstractClass):
    delta: Delta = Field(sa_type=JSONB, nullable=False)
    """How this write's text differs from the entry's previous text."""


class BlobContentRow(ContentRow, IsAbstractClass):
    hash: str = Field(index=True, nullable=False)


class TextCacheRow(WithID, IsAbstractClass):
    """Derived, never authoritative: one entry's text as of one write.

    Reconstruction folds deltas, which is linear in an entry's history. This
    row anchors the fold at the newest write so the common read is free and
    older ones are recovered by inverting a few deltas backwards. Deleting the
    whole table only costs time.
    """

    entry_id: ID
    content_id: ID
    content: str = Field(nullable=False)


class TokenRow(SQLModel, IsAbstractClass):  # pyright: ignore[reportUnsafeMultipleInheritance]
    """Single-use, position-bound credential minted by Initialize."""

    token: str = Field(primary_key=True)
    user_id: ID
    workspace_id: ID
    position: int = Field(nullable=False)
    expires: datetime = Field(
        # SQLModel annotates sa_type as `type[Any]` but hands it to Column(),
        # which takes an instance just as happily.
        sa_type=cast(type[TypeEngine[Any]], TIMESTAMP(timezone=True)),
        nullable=False,
    )


def stamped_by_the_choke_point() -> CheckConstraint:
    return CheckConstraint("position > 0", name="stamped_by_the_choke_point")


def _table_of(named: str | type[WithTableName]) -> str:
    """A host's table, however they care to name it."""
    return named if isinstance(named, str) else get_tablename(named)


@final
@dataclass(frozen=True)
class Models:
    """One wsfs schema, bound to one host's users and workspaces.

    Handed to `Workspaces.over` and carried from there: every query in this
    package reads its tables off this object rather than importing them, so
    two of these can coexist in one process against two different hosts.
    """

    entry: type[EntryRow]
    name: type[NameRow]
    parent: type[ParentRow]
    deletion: type[DeletionRow]
    text_content: type[TextContentRow]
    blob_content: type[BlobContentRow]
    text_cache: type[TextCacheRow]
    token: type[TokenRow]

    @property
    def logs(self) -> tuple[type[TransactionRow], ...]:
        """The five append-only logs, which are also the event stream."""
        return (
            self.name,
            self.parent,
            self.deletion,
            self.text_content,
            self.blob_content,
        )

    @property
    def content(self) -> tuple[type[ContentRow], ...]:
        return (self.text_content, self.blob_content)

    @property
    def tables(self) -> tuple[type[SQLModel], ...]:
        """Everything this schema owns -- for create_all, or a migration."""
        return (self.entry, *self.logs, self.text_cache, self.token)


def build_models(
    *,
    user_table: str | type[WithTableName],
    workspace_table: str | type[WithTableName],
    prefix: str = DEFAULT_PREFIX,
) -> Models:
    """The tables, pointed at the host's users and workspaces.

    Only two things about the host are needed, and neither is a class: the
    table a `user_id` refers to, and the table a `workspace_id` refers to.
    Nothing in this package reads a user or a workspace -- it stores their
    ids, and scopes queries by them -- so the host keeps every decision about
    what those are and who may reach them.

    `prefix` names the tables and the entry-type enum. Two wsfs schemas in one
    process need two prefixes, because SQLModel registers tables by name.
    Building the same prefix twice with the same arguments returns the schema
    already built; with different ones it raises, because that is a collision
    rather than a repeat.
    """
    users, workspaces = _table_of(user_table), _table_of(workspace_table)
    signature = (users, workspaces, prefix)
    if prefix in _BUILT:
        return _already_built(signature)
    _BUILT[prefix] = (signature, _build(users, workspaces, prefix))
    return _BUILT[prefix][1]


_BUILT: dict[str, tuple[tuple[str, str, str], Models]] = {}


def _already_built(signature: tuple[str, str, str]) -> Models:
    built, models = _BUILT[signature[2]]
    if built != signature:
        raise ValueError(
            f"a wsfs schema prefixed {signature[2]!r} already points at "
            f"{built[0]}/{built[1]}, not {signature[0]}/{signature[1]}. "
            "Give the second schema its own prefix."
        )
    return models


def _build(users: str, workspaces: str, prefix: str) -> Models:
    with warnings.catch_warnings():
        # A second schema re-registers these class NAMES in SQLAlchemy's
        # declarative registry, which matters only for resolving a
        # `relationship("Entry")` by string. This package declares no
        # relationships at all -- every join here is written out.
        warnings.filterwarnings("ignore", message=".*already contains a class.*")
        return _tables(users, workspaces, prefix)


def _tables(users: str, workspaces: str, prefix: str) -> Models:
    def named(part: str) -> type[WithTableName]:
        return tablename("custom", f"{prefix}_{part}")

    def logged(part: str) -> tuple[SchemaItem, ...]:
        """Only a create writes more than one log at a position, which is what
        makes "these rows are one transaction" a fact rather than a
        convention."""
        return (
            stamped_by_the_choke_point(),
            Index(f"ix_{prefix}_{part}_entry_position", "entry_id", "position"),
        )

    class Entry(EntryRow, named("entries"), table=True):
        workspace_id: ID = ForeignKeyField(workspaces)
        type: Type = EnumField(Type, name=f"{prefix}_entry_type")

    class Transaction(TransactionRow, IsAbstractClass):
        """The two ids every log row carries. Declared here, ahead of each
        log's own shape in the MRO, because these are the ones that had to
        wait for a host to say where they point."""

        entry_id: ID = ForeignKeyField(Entry)
        user_id: ID = ForeignKeyField(users)

    class Name(Transaction, NameRow, named("names"), table=True):
        __table_args__: ClassVar[tuple[SchemaItem, ...]] = logged("names")

    class Parent(Transaction, ParentRow, named("parentage"), table=True):
        parent_entry_id: ID | None = ForeignKeyField(Entry, nullable=True)

        __table_args__: ClassVar[tuple[SchemaItem, ...]] = logged("parentage")

    class Deletion(Transaction, DeletionRow, named("deletions"), table=True):
        __table_args__: ClassVar[tuple[SchemaItem, ...]] = logged("deletions")

    class TextContent(Transaction, TextContentRow, named("text_content"), table=True):
        __table_args__: ClassVar[tuple[SchemaItem, ...]] = logged("text_content")

    class BlobContent(Transaction, BlobContentRow, named("blob_content"), table=True):
        __table_args__: ClassVar[tuple[SchemaItem, ...]] = logged("blob_content")

    class TextContentCache(TextCacheRow, named("text_cache"), table=True):
        entry_id: ID = ForeignKeyField(Entry)
        content_id: ID = ForeignKeyField(TextContent)

        __table_args__: ClassVar[tuple[SchemaItem, ...]] = (UniqueConstraint("entry_id"),)

    class StreamToken(TokenRow, named("stream_tokens"), table=True):
        user_id: ID = ForeignKeyField(users)
        workspace_id: ID = ForeignKeyField(workspaces)

    return Models(
        entry=Entry,
        name=Name,
        parent=Parent,
        deletion=Deletion,
        text_content=TextContent,
        blob_content=BlobContent,
        text_cache=TextContentCache,
        token=StreamToken,
    )
