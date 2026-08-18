"""Adjudication + the choke point.

Every mutation flows through commit(): per-workspace lock -> apply ->
bump position -> event row + transaction record, all in ONE db transaction.
(SQLite serializes writers anyway; with_for_update() is the Postgres path.)

Every transactional handler is dedup-aware: presenting a transaction id the
server has seen returns the recorded outcome, never re-applies. This is what
makes retries and Initialize reconciliation safe.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from sqlmodel import Session, select

from .models import (
    ContentVersion,
    Entry,
    EntryVersion,
    EventRow,
    TransactionRecord,
    Workspace,
    new_id,
)


@dataclass
class Outcome:
    """Adjudication result: mirrors Responded/Acknowledged/Failure.

    events carries (position, payload) pairs emitted by this outcome's
    commit, for the controller to fan out AFTER the db transaction commits.
    A deduped replay returns the recorded outcome with NO events — it was
    fanned out the first time."""

    rejected: bool
    reason: str | None = None
    conflict_version: str | None = None
    created_entry_id: str | None = None
    events: list[tuple[int, str]] = field(default_factory=list)

    def to_response(self) -> dict[str, Any]:
        if not self.rejected:
            body: dict[str, Any] = {"rejected": False}
            if self.created_entry_id:
                body["id"] = self.created_entry_id
            return body
        body = {"rejected": True, "reason": self.reason}
        if self.conflict_version:
            body["version"] = self.conflict_version
        return body


def _dedup(session: Session, txn: str) -> Outcome | None:
    rec = session.get(TransactionRecord, txn)
    if rec is None:
        return None
    return Outcome(rec.rejected, rec.reason, rec.conflict_version, rec.created_entry_id)


def _commit(
    session: Session,
    *,
    workspace_id: str,
    user: str,
    txn: str,
    outcome: Outcome,
    event: dict[str, Any] | None,
) -> Outcome:
    """The choke point. Records the outcome; on success, bumps the position
    and appends the stream event — all in the caller's open transaction."""
    position: int | None = None
    if not outcome.rejected:
        ws = session.exec(
            select(Workspace).where(Workspace.id == workspace_id).with_for_update()
        ).one()
        ws.position += 1
        position = ws.position
        session.add(ws)
        assert event is not None
        payload = json.dumps({**event, "user": user, "transaction": txn})
        session.add(
            EventRow(workspace_id=workspace_id, position=position, payload=payload)
        )
        outcome.events.append((position, payload))
    session.add(
        TransactionRecord(
            id=txn,
            user=user,
            workspace_id=workspace_id,
            rejected=outcome.rejected,
            reason=outcome.reason,
            conflict_version=outcome.conflict_version,
            created_entry_id=outcome.created_entry_id,
            position=position,
        )
    )
    return outcome


def _snapshot_version(session: Session, entry: Entry, content_id: str | None = None) -> str:
    prev = session.get(EntryVersion, entry.version) if entry.version else None
    ev = EntryVersion(
        entry_id=entry.id,
        name=entry.name,
        parent_id=entry.parent_id,
        deleted=entry.deleted,
        content_id=content_id if content_id is not None else (prev.content_id if prev else None),
    )
    session.add(ev)
    entry.version = ev.id
    session.add(entry)
    return ev.id


def _name_taken(session: Session, workspace_id: str, parent_id: str | None, name: str, *, exclude: str) -> bool:
    q = select(Entry).where(
        Entry.workspace_id == workspace_id,
        Entry.parent_id == parent_id,
        Entry.name == name,
        Entry.deleted == False,  # noqa: E712
        Entry.id != exclude,
    )
    return session.exec(q).first() is not None


def _get_live(session: Session, workspace_id: str, entry_id: str) -> Entry | None:
    e = session.get(Entry, entry_id)
    if e is None or e.workspace_id != workspace_id:
        return None
    return e


# ---------------------------------------------------------------------------
# Handlers — one per ClientSent request type
# ---------------------------------------------------------------------------

def create(session: Session, ws: str, user: str, req: dict) -> Outcome:
    if (o := _dedup(session, req["transaction"])) is not None:
        return o
    parent_id = req.get("parent")
    if parent_id is not None:
        parent = _get_live(session, ws, parent_id)
        if parent is None or parent.deleted or parent.type != "folder":
            return _commit(session, workspace_id=ws, user=user, txn=req["transaction"],
                           outcome=Outcome(True, "parent was deleted"), event=None)
    entry = Entry(workspace_id=ws, type=req["type"], name=req["name"],
                  parent_id=parent_id, version="")
    session.add(entry)
    version = _snapshot_version(session, entry)
    event = {"type": "create", "id": entry.id, "version": version,
             "value": _meta(entry)}
    return _commit(session, workspace_id=ws, user=user, txn=req["transaction"],
                   outcome=Outcome(False, created_entry_id=entry.id), event=event)


def delete(session: Session, ws: str, user: str, req: dict) -> Outcome:
    if (o := _dedup(session, req["transaction"])) is not None:
        return o
    entry = _get_live(session, ws, req["id"])
    if entry is None:
        return _commit(session, workspace_id=ws, user=user, txn=req["transaction"],
                       outcome=Outcome(True, "entry was deleted"), event=None)
    if entry.version != req["version"]:
        outcome = Outcome(True, _delete_conflict_reason(session, entry, req["version"]),
                          conflict_version=entry.version)
        return _commit(session, workspace_id=ws, user=user, txn=req["transaction"],
                       outcome=outcome, event=None)
    entry.deleted = True
    version = _snapshot_version(session, entry)
    event = {"type": "delete", "id": entry.id, "version": version, "value": True}
    return _commit(session, workspace_id=ws, user=user, txn=req["transaction"],
                   outcome=Outcome(False), event=event)


def _delete_conflict_reason(session: Session, entry: Entry, presented: str) -> str:
    old = session.get(EntryVersion, presented)
    cur = session.get(EntryVersion, entry.version)
    if old is None or cur is None:
        return "later versions modified the content and name of the entry"
    name_changed = old.name != cur.name
    content_changed = old.content_id != cur.content_id
    what = ("content and name" if (name_changed and content_changed)
            else "name" if name_changed else "content")
    return f"later versions modified the {what} of the entry"


def rename(session: Session, ws: str, user: str, req: dict) -> Outcome:
    if (o := _dedup(session, req["transaction"])) is not None:
        return o
    entry = _get_live(session, ws, req["id"])
    if entry is None or entry.deleted:
        return _commit(session, workspace_id=ws, user=user, txn=req["transaction"],
                       outcome=Outcome(True, "entry was deleted"), event=None)
    if entry.version != req["version"]:
        return _commit(session, workspace_id=ws, user=user, txn=req["transaction"],
                       outcome=Outcome(True, "entry was already renamed",
                                       conflict_version=entry.version), event=None)
    if _name_taken(session, ws, entry.parent_id, req["name"], exclude=entry.id):
        return _commit(session, workspace_id=ws, user=user, txn=req["transaction"],
                       outcome=Outcome(True, "entry with name already exists within destination"),
                       event=None)
    entry.name = req["name"]
    version = _snapshot_version(session, entry)
    event = {"type": "name", "id": entry.id, "version": version, "value": entry.name}
    return _commit(session, workspace_id=ws, user=user, txn=req["transaction"],
                   outcome=Outcome(False), event=event)


def reparent(session: Session, ws: str, user: str, req: dict) -> Outcome:
    if (o := _dedup(session, req["transaction"])) is not None:
        return o
    entry = _get_live(session, ws, req["id"])
    if entry is None or entry.deleted:
        return _commit(session, workspace_id=ws, user=user, txn=req["transaction"],
                       outcome=Outcome(True, "entry was deleted"), event=None)
    dest_id = req.get("parent")
    if dest_id is not None:
        dest = _get_live(session, ws, dest_id)
        if dest is None or dest.deleted or dest.type != "folder":
            return _commit(session, workspace_id=ws, user=user, txn=req["transaction"],
                           outcome=Outcome(True, "the destination was deleted"), event=None)
    if entry.version != req["version"]:
        return _commit(session, workspace_id=ws, user=user, txn=req["transaction"],
                       outcome=Outcome(True, "entry had already been moved",
                                       conflict_version=entry.version), event=None)
    if _name_taken(session, ws, dest_id, entry.name, exclude=entry.id):
        return _commit(session, workspace_id=ws, user=user, txn=req["transaction"],
                       outcome=Outcome(True, "entry with name already exists within destination"),
                       event=None)
    entry.parent_id = dest_id
    version = _snapshot_version(session, entry)
    event = {"type": "parent", "id": entry.id, "version": version, "value": dest_id}
    return _commit(session, workspace_id=ws, user=user, txn=req["transaction"],
                   outcome=Outcome(False), event=event)


def write(session: Session, ws: str, user: str, req: dict) -> Outcome:
    if (o := _dedup(session, req["transaction"])) is not None:
        return o
    entry = _get_live(session, ws, req["id"])
    if entry is None or entry.deleted:
        # Typed failure whose CONTENT the client routes to Drafts.
        return _commit(session, workspace_id=ws, user=user, txn=req["transaction"],
                       outcome=Outcome(True, "entry was deleted"), event=None)
    if entry.version != req["version"]:
        return _commit(session, workspace_id=ws, user=user, txn=req["transaction"],
                       outcome=Outcome(True, "content was already updated",
                                       conflict_version=entry.version), event=None)
    if req["content_kind"] == "text":
        cv = ContentVersion(entry_id=entry.id, kind="text", text=req["content"],
                            size=len(req["content"].encode()), mime="text/plain")
    else:
        cv = ContentVersion(entry_id=entry.id, kind="binary", hash=req["hash"],
                            size=req["size"], mime=req["mime"])
    session.add(cv)
    session.flush()  # assign cv.id
    version = _snapshot_version(session, entry, content_id=cv.id)
    # "write" is a PURE INVALIDATION SIGNAL — no payload beyond id+version.
    event = {"type": "write", "id": entry.id, "version": version}
    return _commit(session, workspace_id=ws, user=user, txn=req["transaction"],
                   outcome=Outcome(False), event=event)


HANDLERS = {
    "create": create,
    "delete": delete,
    "rename": rename,
    "reparent": reparent,
    "write": write,
}


def _meta(entry: Entry) -> dict[str, Any]:
    m: dict[str, Any] = {
        "id": entry.id, "version": entry.version, "name": entry.name,
        "type": entry.type,
    }
    if entry.parent_id is not None:
        m["parent"] = entry.parent_id
    if entry.deleted:
        m["deleted"] = True
    return m


def snapshot(session: Session, workspace_id: str) -> list[dict[str, Any]]:
    """All entries INCLUDING tombstones — reconciliation depends on them."""
    entries = session.exec(select(Entry).where(Entry.workspace_id == workspace_id)).all()
    return [_meta(e) for e in entries]
