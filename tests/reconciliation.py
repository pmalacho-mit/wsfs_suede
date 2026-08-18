"""Initialize: the handshake that is also cold start, reconnect and recovery."""

from sqlmodel import Session, func, select

from conftest import Api, acknowledged, created, listening, refused, version_of
from release.backend.models import Deletion, Name, Parent, TextContent


async def test_an_empty_outbox_is_a_cheap_no_op(api: Api):
    created(await api.create("a.py"))

    first = await api.initialize()
    second = await api.initialize()

    assert first["entries"] == second["entries"]
    assert (second["applied"], second["rejected"]) == ([], [])
    assert first["token"] != second["token"]


async def test_tombstones_stay_in_the_snapshot(api: Api):
    file = created(await api.create("a.py"))
    acknowledged(await api.delete(file, await version_of(api, file)))

    entry = next(e for e in (await api.initialize())["entries"] if e["id"] == file)
    assert entry["deleted"] is True


async def test_an_outbox_is_applied_in_the_order_it_was_queued(api: Api):
    folder = created(await api.create("src", type="folder"))
    file = created(await api.create("a.py"))
    held = await version_of(api, file)

    snapshot = await api.initialize(
        [
            {"op": "rename", "transaction": api.transaction(), "id": file, "version": held, "name": "b.py"},
            {"op": "write", "type": "text", "transaction": api.transaction(), "id": file,
             "version": held, "content": "offline work"},
            {"op": "reparent", "transaction": api.transaction(), "id": file, "version": held,
             "parent": folder},
        ]
    )

    # Every item after the first presents a token the replay itself superseded:
    # the client was offline and could not have learned the new ones.
    assert len(snapshot["applied"]) == 3
    moved = next(e for e in snapshot["entries"] if e["id"] == file)
    assert (moved["name"], moved["parent"]) == ("b.py", folder)
    assert (await api.content(file)).json()["content"] == "offline work"


async def test_an_outbox_still_loses_to_somebody_elses_work(api: Api, other: Api):
    file = created(await api.create("a.py"))
    held = await version_of(api, file)
    acknowledged(await other.rename(file, held, "theirs.py"))

    snapshot = await api.initialize(
        [{"op": "write", "type": "text", "transaction": api.transaction(), "id": file,
          "version": held, "content": "mine"}]
    )

    assert snapshot["applied"] == []
    assert snapshot["rejected"][0]["reason"] == "content was already updated"


async def test_a_queued_delete_after_a_queued_rename_still_deletes(api: Api):
    file = created(await api.create("a.py"))
    held = await version_of(api, file)

    snapshot = await api.initialize(
        [
            {"op": "rename", "transaction": api.transaction(), "id": file, "version": held, "name": "b.py"},
            {"op": "delete", "transaction": api.transaction(), "id": file, "version": held},
        ]
    )

    assert len(snapshot["applied"]) == 2
    assert next(e for e in snapshot["entries"] if e["id"] == file)["deleted"] is True


async def test_transactions_the_server_never_saw_are_applied_by_initialize(api: Api):
    file = created(await api.create("a.py"))
    queued = api.transaction()

    snapshot = await api.initialize(
        [{"op": "rename", "transaction": queued, "id": file,
          "version": await version_of(api, file), "name": "renamed.py"}]
    )

    assert snapshot["applied"] == [queued]
    assert [e["name"] for e in snapshot["entries"]] == ["renamed.py"]


async def test_work_applied_by_initialize_reaches_the_other_streams(api: Api, other: Api):
    file = created(await api.create("a.py"))
    token = (await other.initialize())["token"]

    async with listening(other, token) as heard:
        await api.initialize(
            [{"op": "rename", "transaction": api.transaction(), "id": file,
              "version": await version_of(api, file), "name": "b.py"}]
        )
        event = (await heard.until(1))[0]

    assert (event["type"], event["value"]) == ("name", "b.py")


async def test_a_transaction_already_applied_is_reported_not_reapplied(api: Api, session: Session):
    file = created(await api.create("a.py"))
    replayed = api.transaction()
    acknowledged(
        await api.rename(file, await version_of(api, file), "b.py", transaction=replayed)
    )

    snapshot = await api.initialize(
        [{"op": "rename", "transaction": replayed, "id": file,
          "version": await version_of(api, file), "name": "b.py"}]
    )

    assert snapshot["applied"] == [replayed]
    assert session.exec(select(func.count()).select_from(Name)).one() == 2  # create + rename


async def test_a_lost_create_ack_is_retried_without_minting_a_second_entry(api: Api):
    once = api.transaction()
    first = created(await api.create("a.py", transaction=once))

    assert created(await api.create("a.py", transaction=once)) == first
    assert len((await api.initialize())["entries"]) == 1


async def test_a_refused_transaction_writes_nothing(api: Api, session: Session):
    file = created(await api.create("a.py"))
    stale = await version_of(api, file)
    acknowledged(await api.write(file, stale, "first"))

    def rows() -> tuple[int, ...]:
        return tuple(
            session.exec(select(func.count()).select_from(table)).one()
            for table in (Name, Parent, Deletion, TextContent)
        )

    before = rows()
    refused(await api.write(file, stale, "second"))
    session.expire_all()

    assert rows() == before


async def test_re_presenting_a_refused_transaction_gives_the_same_reason(api: Api):
    file = created(await api.create("a.py"))
    stale = await version_of(api, file)
    acknowledged(await api.write(file, stale, "first"))
    doomed = api.transaction()

    refusals = [
        refused(await api.write(file, stale, "second", transaction=doomed)) for _ in range(3)
    ]

    assert refusals[0] == refusals[1] == refusals[2]
    assert refusals[0]["reason"] == "content was already updated"


async def test_a_refusal_reports_the_version_the_conflict_ux_needs_now(api: Api):
    file = created(await api.create("a.py"))
    stale = await version_of(api, file)
    acknowledged(await api.write(file, stale, "first"))
    doomed = api.transaction()
    refused(await api.write(file, stale, "second", transaction=doomed))

    acknowledged(await api.write(file, await version_of(api, file), "third"))
    again = refused(await api.write(file, stale, "second", transaction=doomed))

    # Not the version it lost to back then -- the one it would lose to now.
    assert again["version"] == await version_of(api, file)


async def test_an_outbox_refusal_is_reported_against_its_transaction(api: Api):
    file = created(await api.create("a.py"))
    stale = await version_of(api, file)
    acknowledged(await api.rename(file, stale, "b.py"))
    doomed = api.transaction()

    snapshot = await api.initialize(
        [{"op": "rename", "transaction": doomed, "id": file, "version": stale, "name": "c.py"}]
    )

    assert snapshot["applied"] == []
    assert snapshot["rejected"] == [
        {"transaction": doomed, "reason": "entry was already renamed",
         "version": await version_of(api, file)}
    ]


async def test_an_unknown_workspace_is_not_found(instance):
    response = await instance.post(
        "/workspaces/00000000-0000-4000-8000-000000000000/initialize",
        json={"outbox": []},
        headers={"X-User-Email": "ada@example.com"},
    )
    assert response.status_code == 404
