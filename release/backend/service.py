"""Adjudication, and the one path every applied mutation takes.

The two halves are kept apart on purpose.

`refusal()` is judgement, and it is pure: it reads the workspace and answers
why a request cannot be applied, or None. Nothing about a refusal is stored,
because nothing about a refusal happened -- presenting the same transaction
again re-runs this function and produces the same answer, computed against the
workspace as it stands rather than as it once stood.

`approve()` is the choke point, and it is the only thing that writes: position
bump, transaction rows and version row all land in the caller's single
database transaction, so the event log cannot drift from the truth it is
generated out of.

Dedup therefore only has to protect what was applied: finding a transaction id
in its table means the change already happened, and the recorded answer is
served instead of a second application.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable
from uuid import UUID

from sqlmodel import Session, select

from . import stream, text, tree
from .blobs import Blobs
from .contract import (
    Acknowledged,
    Create,
    Created,
    Delete,
    Kind,
    Metadata,
    Operation,
    Refusal,
    Rejected,
    Rename,
    Reparent,
    Response,
    Submitted,
    Transacted,
    Versioned,
    WriteBinary,
    WriteText,
)
from .diff import diff_to_delta
from .models import (
    BlobContent,
    Deletion,
    Entry,
    Event,
    Name,
    Parent,
    TextContent,
    Transaction,
    User,
    Version,
    Workspace,
)
from .tree import Node


@dataclass
class Outcome:
    """What the client is told, and what the workspace's streams are told."""

    response: Response
    events: list[stream.Emitted] = field(default_factory=list)


@dataclass(frozen=True)
class Submission:
    """One request being adjudicated against one workspace."""

    session: Session
    workspace: UUID
    user: User
    blobs: Blobs

    def node(self, entry_id: UUID) -> Node | None:
        return tree.node(self.session, self.workspace, entry_id)

    def name_taken(self, *, parent: UUID | None, name: str, excluding: UUID | None) -> bool:
        return tree.name_taken(
            self.session, self.workspace, parent=parent, name=name, excluding=excluding
        )

    def can_receive(self, parent: UUID | None) -> bool:
        """A folder still reachable from the root, or the root itself."""
        if parent is None:
            return True
        holder = self.node(parent)
        return holder is not None and holder.is_folder and self.is_reachable(holder)

    def is_reachable(self, node: Node) -> bool:
        return not node.deleted and not tree.has_deleted_ancestor(
            self.session, self.workspace, node.id
        )


def _stale(node: Node, request: Versioned) -> bool:
    return node.version.id != request.version


def _already_gone(node: Node | None) -> bool:
    return node is not None and node.deleted


# -- judgement: why a request cannot be applied, if it cannot --------------------


def _refuses_create(submission: Submission, request: Create) -> str | None:
    if not submission.can_receive(request.parent):
        return Refusal.PARENT_DELETED
    if submission.name_taken(parent=request.parent, name=request.name, excluding=None):
        return Refusal.NAME_TAKEN
    return None


def _refuses_delete(submission: Submission, request: Delete) -> str | None:
    node = submission.node(request.id)
    if node is None:
        return Refusal.ENTRY_DELETED
    if _already_gone(node):
        return None  # already what was asked for; nothing to refuse
    if _stale(node, request):
        return _what_later_versions_touched(submission, node, request.version)
    return None


def _what_later_versions_touched(
    submission: Submission, node: Node, presented: UUID
) -> str:
    """Delete's refusal names what the client would have destroyed unseen.

    A move counts as a change of name: both change where the entry lives in
    the namespace, and the contract's reasons have no third word.
    """
    was = submission.session.get(Version, presented)
    if was is None or was.entry_id != node.id:
        return Refusal.modified(name=True, content=True)
    now = node.version
    return Refusal.modified(
        name=(was.name_id, was.parent_id) != (now.name_id, now.parent_id),
        content=(was.text_content_id, was.blob_content_id)
        != (now.text_content_id, now.blob_content_id),
    )


def _refuses_rename(submission: Submission, request: Rename) -> str | None:
    node = submission.node(request.id)
    if node is None or node.deleted:
        return Refusal.ENTRY_DELETED
    if _stale(node, request):
        return Refusal.ALREADY_RENAMED
    if submission.name_taken(parent=node.parent, name=request.name, excluding=node.id):
        return Refusal.NAME_TAKEN
    return None


def _refuses_reparent(submission: Submission, request: Reparent) -> str | None:
    node = submission.node(request.id)
    if node is None or node.deleted:
        return Refusal.ENTRY_DELETED
    if _stale(node, request):
        return Refusal.ALREADY_MOVED
    if not submission.can_receive(request.parent):
        return Refusal.DESTINATION_DELETED
    if _would_detach_the_subtree(submission, node, request.parent):
        return Refusal.DESTINATION_INSIDE_ENTRY
    if submission.name_taken(parent=request.parent, name=node.name, excluding=node.id):
        return Refusal.NAME_TAKEN
    return None


def _would_detach_the_subtree(
    submission: Submission, moving: Node, destination: UUID | None
) -> bool:
    """Moving a folder inside itself severs it from the root, unreachably."""
    return destination is not None and tree.descends_from(
        submission.session, submission.workspace, destination, moving.id
    )


def _refuses_write(submission: Submission, request: WriteText | WriteBinary) -> str | None:
    node = submission.node(request.id)
    if node is None or node.deleted:
        # The bytes are not lost with the transaction: the client parks them.
        return Refusal.ENTRY_DELETED
    if _stale(node, request):
        return Refusal.ALREADY_WRITTEN
    if isinstance(request, WriteBinary) and not submission.blobs.holds(request.hash):
        return Refusal.BYTES_NEVER_STORED
    return None


_JUDGEMENT: dict[Operation, Callable[[Submission, Any], str | None]] = {
    Operation.CREATE: _refuses_create,
    Operation.DELETE: _refuses_delete,
    Operation.RENAME: _refuses_rename,
    Operation.REPARENT: _refuses_reparent,
    Operation.WRITE: _refuses_write,
}


def refusal(submission: Submission, request: Submitted) -> str | None:
    """Why this request cannot be applied to this workspace, if it cannot.

    Reads only. Re-running it is how the reason for an earlier refusal is
    recovered, so no refusal is ever written down.
    """
    return _JUDGEMENT[request.op](submission, request)


# -- the choke point ---------------------------------------------------------------


def _next_position(submission: Submission) -> int:
    """Serialized by the workspace controller; the row lock is the insurance
    that turns an accidental second process from corruption into contention."""
    workspace = submission.session.exec(
        select(Workspace).where(Workspace.id == submission.workspace).with_for_update()
    ).one()
    workspace.position += 1
    submission.session.add(workspace)
    return workspace.position


def _carried_over(previous: Version | None) -> dict[str, Any]:
    if previous is None:
        return {}
    return {
        "name_id": previous.name_id,
        "parent_id": previous.parent_id,
        "deleted_id": previous.deleted_id,
        "text_content_id": previous.text_content_id,
        "blob_content_id": previous.blob_content_id,
    }


def approve(
    submission: Submission,
    *,
    entry_id: UUID,
    event: Event,
    applied: list[Transaction],
    previous: Version | None,
    **introduced: Any,
) -> Version:
    """Append the changes and the version they compose, at the next position."""
    version = Version(
        entry_id=entry_id,
        event=event,
        position=_next_position(submission),
        **{**_carried_over(previous), **introduced},
    )
    submission.session.add_all([*applied, version])
    submission.session.flush()
    return version


def _acknowledge(
    submission: Submission, version: Version, response: Response | None = None
) -> Outcome:
    return Outcome(response or Acknowledged(), [stream.of(submission.session, version.id)])


def _by(user: User, request: Transacted) -> dict[str, Any]:
    return {"user_id": user.id, "transaction": request.transaction}


# -- application: what an accepted request appends ------------------------------------


def _apply_create(submission: Submission, request: Create) -> Outcome:
    entry = Entry(workspace_id=submission.workspace, type=request.type)
    submission.session.add(entry)
    stamp = _by(submission.user, request)
    naming = Name(entry_id=entry.id, name=request.name, **stamp)
    parentage = Parent(entry_id=entry.id, parent_entry_id=request.parent, **stamp)
    deletion = Deletion(entry_id=entry.id, deleted=False, **stamp)
    version = approve(
        submission,
        entry_id=entry.id,
        event=Event.CREATE,
        applied=[naming, parentage, deletion],
        previous=None,
        name_id=naming.id,
        parent_id=parentage.id,
        deleted_id=deletion.id,
    )
    return _acknowledge(submission, version, Created(id=entry.id))


def _apply_delete(submission: Submission, request: Delete) -> Outcome:
    node = _live(submission, request)
    if _already_gone(node):
        # Acknowledging beats inventing a refusal for work already done.
        return Outcome(Acknowledged())
    deletion = Deletion(entry_id=node.id, deleted=True, **_by(submission.user, request))
    version = approve(
        submission,
        entry_id=node.id,
        event=Event.DELETE,
        applied=[deletion],
        previous=node.version,
        deleted_id=deletion.id,
    )
    return _acknowledge(submission, version)


def _apply_rename(submission: Submission, request: Rename) -> Outcome:
    node = _live(submission, request)
    naming = Name(entry_id=node.id, name=request.name, **_by(submission.user, request))
    version = approve(
        submission,
        entry_id=node.id,
        event=Event.NAME,
        applied=[naming],
        previous=node.version,
        name_id=naming.id,
    )
    return _acknowledge(submission, version)


def _apply_reparent(submission: Submission, request: Reparent) -> Outcome:
    node = _live(submission, request)
    parentage = Parent(
        entry_id=node.id, parent_entry_id=request.parent, **_by(submission.user, request)
    )
    version = approve(
        submission,
        entry_id=node.id,
        event=Event.PARENT,
        applied=[parentage],
        previous=node.version,
        parent_id=parentage.id,
    )
    return _acknowledge(submission, version)


def _apply_write(submission: Submission, request: WriteText | WriteBinary) -> Outcome:
    node = _live(submission, request)
    content = _content_of(submission, node, request)
    version = approve(
        submission,
        entry_id=node.id,
        event=Event.WRITE,
        applied=[content],
        previous=node.version,
        text_content_id=content.id if isinstance(content, TextContent) else None,
        blob_content_id=content.id if isinstance(content, BlobContent) else None,
    )
    if isinstance(request, WriteText):
        text.remember(submission.session, version, request.content)
    return _acknowledge(submission, version)


def _content_of(
    submission: Submission, node: Node, request: WriteText | WriteBinary
) -> TextContent | BlobContent:
    stamp = _by(submission.user, request)
    if isinstance(request, WriteBinary):
        return BlobContent(
            entry_id=node.id, hash=request.hash, size=request.size, mime=request.mime, **stamp
        )
    return TextContent(
        entry_id=node.id,
        size=len(request.content.encode()),
        mime="text/plain",
        delta=diff_to_delta(text.at(submission.session, node.version), request.content),
        **stamp,
    )


def _live(submission: Submission, request: Versioned) -> Node:
    """The entry an accepted request names -- judgement has already found it."""
    node = submission.node(request.id)
    if node is None:
        raise LookupError(f"entry {request.id} vanished between judgement and application")
    return node


_APPLICATION: dict[Operation, Callable[[Submission, Any], Outcome]] = {
    Operation.CREATE: _apply_create,
    Operation.DELETE: _apply_delete,
    Operation.RENAME: _apply_rename,
    Operation.REPARENT: _apply_reparent,
    Operation.WRITE: _apply_write,
}


# -- dedup, and the two halves joined -------------------------------------------------

_TRANSACTION_TABLE: dict[Operation, type[Transaction]] = {
    Operation.CREATE: Name,
    Operation.RENAME: Name,
    Operation.REPARENT: Parent,
    Operation.DELETE: Deletion,
}


def _table_for(request: Submitted) -> type[Transaction]:
    if request.op is not Operation.WRITE:
        return _TRANSACTION_TABLE[request.op]
    return TextContent if request.type is Kind.TEXT else BlobContent


def _already_applied(submission: Submission, request: Submitted) -> Outcome | None:
    table = _table_for(request)
    recorded = submission.session.exec(
        select(table).where(table.transaction == request.transaction)
    ).first()
    if recorded is None:
        return None
    if request.op is Operation.CREATE:
        return Outcome(Created(id=recorded.entry_id))
    return Outcome(Acknowledged())


def _conflicting_version(submission: Submission, request: Submitted) -> UUID | None:
    """What the conflict UX needs NOW: the affected entry's current version."""
    if isinstance(request, Create):
        return None
    node = submission.node(request.id)
    return None if node is None else node.version.id


def adjudicate(submission: Submission, request: Submitted) -> Outcome:
    applied = _already_applied(submission, request)
    if applied is not None:
        return applied
    refused = refusal(submission, request)
    if refused is not None:
        return Outcome(
            Rejected(reason=refused, version=_conflicting_version(submission, request))
        )
    return _APPLICATION[request.op](submission, request)


def snapshot(session: Session, workspace_id: UUID) -> list[Metadata]:
    return [node.metadata for node in tree.nodes(session, workspace_id)]
