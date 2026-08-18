"""The stream: one ordered channel, claimed once, spliced without a gap."""

import asyncio

from conftest import Api, acknowledged, created, listening, version_of


async def test_every_mutation_reaches_the_stream_in_order(api: Api):
    token = (await api.initialize())["token"]
    async with listening(api, token) as heard:
        folder = created(await api.create("src", type="folder"))
        file = created(await api.create("a.py", parent=folder))
        acknowledged(await api.write(file, await version_of(api, file), "hello"))
        acknowledged(await api.rename(file, await version_of(api, file), "b.py"))
        acknowledged(await api.reparent(file, await version_of(api, file), None))
        acknowledged(await api.delete(file, await version_of(api, file)))

        events = await heard.until(6)

    assert [event["type"] for event in events] == [
        "create", "create", "write", "name", "parent", "delete",
    ]


async def test_a_create_event_carries_the_whole_entry(api: Api):
    token = (await api.initialize())["token"]
    async with listening(api, token) as heard:
        folder = created(await api.create("src", type="folder"))
        created(await api.create("a.py", parent=folder))
        events = await heard.until(2)

    assert events[0]["value"] == {
        "id": folder,
        "version": events[0]["version"],
        "type": "folder",
        "name": "src",
    }
    assert events[1]["value"]["parent"] == folder


async def test_a_write_event_is_a_pure_invalidation_signal(api: Api):
    file = created(await api.create("a.py"))
    token = (await api.initialize())["token"]
    async with listening(api, token) as heard:
        acknowledged(await api.write(file, await version_of(api, file), "secret"))
        event = (await heard.until(1))[0]

    assert set(event) == {"type", "id", "version", "user", "transaction"}
    assert "secret" not in str(event)


async def test_a_move_to_the_root_carries_an_explicit_null(api: Api):
    folder = created(await api.create("src", type="folder"))
    file = created(await api.create("a.py", parent=folder))
    token = (await api.initialize())["token"]
    async with listening(api, token) as heard:
        acknowledged(await api.reparent(file, await version_of(api, file), None))
        event = (await heard.until(1))[0]

    assert event["value"] is None


async def test_the_internal_position_never_reaches_a_client(api: Api):
    token = (await api.initialize())["token"]
    async with listening(api, token) as heard:
        created(await api.create("a.py"))
        event = (await heard.until(1))[0]

    assert "position" not in event


async def test_every_event_names_the_transaction_that_caused_it(api: Api):
    token = (await api.initialize())["token"]
    async with listening(api, token) as heard:
        transaction = api.transaction()
        created(await api.create("a.py", transaction=transaction))
        event = (await heard.until(1))[0]

    assert event["transaction"] == transaction


async def test_a_stream_replays_what_it_missed_before_going_live(api: Api):
    token = (await api.initialize())["token"]
    created(await api.create("missed-while-connecting.py"))

    async with listening(api, token) as heard:
        created(await api.create("seen-live.py"))
        events = await heard.until(2)

    assert [event["value"]["name"] for event in events] == [
        "missed-while-connecting.py",
        "seen-live.py",
    ]


async def test_a_snapshot_and_its_token_leave_no_gap_and_no_overlap(api: Api):
    created(await api.create("before.py"))
    snapshot = await api.initialize()

    async with listening(api, snapshot["token"]) as heard:
        created(await api.create("after.py"))
        events = await heard.until(1)

    assert [entry["name"] for entry in snapshot["entries"]] == ["before.py"]
    assert [event["value"]["name"] for event in events] == ["after.py"]


async def test_a_token_is_spent_by_the_connection_that_claims_it(api: Api):
    token = (await api.initialize())["token"]
    async with listening(api, token):
        async with api.stream(token) as second:
            assert second.status_code == 401


async def test_two_connections_racing_one_token_produce_exactly_one_winner(api: Api):
    token = (await api.initialize())["token"]

    async def connect() -> int:
        async with api.stream(token) as response:
            return response.status_code

    statuses = await asyncio.gather(connect(), connect())
    assert sorted(statuses) == [200, 401]


async def test_an_unknown_token_is_refused(api: Api):
    async with api.stream("not-a-token") as response:
        assert response.status_code == 401


async def test_every_subscriber_sees_every_event(api: Api, other: Api):
    mine = (await api.initialize())["token"]
    theirs = (await other.initialize())["token"]

    async with listening(api, mine) as heard, listening(other, theirs) as overheard:
        created(await api.create("shared.py"))
        assert (await heard.until(1))[0] == (await overheard.until(1))[0]


async def test_heartbeats_keep_an_idle_stream_alive(api: Api):
    token = (await api.initialize())["token"]
    async with api.stream(token) as response:
        chunks: list[str] = []

        async def read() -> None:
            async for line in response.aiter_lines():
                chunks.append(line)

        reading = asyncio.create_task(read())
        await asyncio.sleep(0.3)  # heartbeat_seconds is 0.05 in tests
        reading.cancel()

    assert ": hb" in chunks
