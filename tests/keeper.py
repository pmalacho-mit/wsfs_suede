"""Keeping every entry's room in step with its file, without racing itself."""

import asyncio

from pycrdt import Doc, Map, Text

from wsfs_suede.samples.backend.keeper import Keeper
from wsfs_suede.samples.backend.rooms import Held

BORN = "01a02361-dad9-755a-ba88-e651f1ad637a"
WROTE = "01a02361-e423-71aa-ad9b-f4bd66c1aeb1"


class FakeLiveblocks:
    """Rooms as bytes, with every call counted."""

    def __init__(self) -> None:
        self.documents: dict[str, bytes] = {}
        self.created: list[str] = []
        self.sent: list[str] = []
        self.reads = 0
        self.answering = asyncio.Event()
        self.answering.set()

    async def create(self, room: str) -> None:
        self.created.append(room)
        self.documents.setdefault(room, b"")

    async def document(self, room: str) -> bytes:
        await self.answering.wait()
        self.reads += 1
        return self.documents.get(room, b"")

    async def send(self, room: str, update: bytes) -> None:
        self.sent.append(room)
        doc = Doc()
        doc["content"] = Text()
        doc["standing"] = Map()
        if self.documents.get(room):
            doc.apply_update(self.documents[room])
        doc.apply_update(update)
        self.documents[room] = doc.get_update()

    def text(self, room: str) -> str:
        doc = Doc()
        doc["content"] = Text()
        doc.apply_update(self.documents[room])
        return str(doc["content"])

    def base(self, room: str) -> str | None:
        doc = Doc()
        doc["standing"] = Map()
        doc.apply_update(self.documents[room])
        return doc["standing"].get("base")


class FakeFiles:
    def __init__(self, now: Held | None, history: dict[str, str] | None = None) -> None:
        self.held = now
        self.history = history or {}

    async def now(self, entry: str) -> Held | None:
        return self.held

    async def at(self, entry: str, version: str) -> str:
        return self.history[version]


def keeping(liveblocks: FakeLiveblocks, files: FakeFiles) -> Keeper:
    return Keeper(liveblocks=liveblocks, files=files)


async def test_a_room_is_created_and_filled_from_the_file():
    liveblocks = FakeLiveblocks()
    keeper = keeping(liveblocks, FakeFiles(Held("hello\n", BORN)))

    await keeper.ensure("entry")

    assert liveblocks.created == ["entry"]
    assert liveblocks.text("entry") == "hello\n"
    assert liveblocks.base("entry") == BORN


async def test_a_room_already_standing_where_the_file_stands_is_left_alone():
    liveblocks = FakeLiveblocks()
    keeper = keeping(liveblocks, FakeFiles(Held("hello\n", BORN)))
    await keeper.ensure("entry")

    await keeper.ensure("entry")

    assert liveblocks.sent == ["entry"]


async def test_a_room_left_behind_has_the_change_carried_into_it():
    liveblocks = FakeLiveblocks()
    files = FakeFiles(Held("hello\n", BORN))
    keeper = keeping(liveblocks, files)
    await keeper.ensure("entry")

    files.held = Held("hello\nfrom a script\n", WROTE)
    files.history = {BORN: "hello\n"}
    await keeper.ensure("entry")

    assert liveblocks.text("entry") == "hello\nfrom a script\n"
    assert liveblocks.base("entry") == WROTE


async def test_unstored_typing_survives_a_change_being_carried_in():
    liveblocks = FakeLiveblocks()
    files = FakeFiles(Held("hello\n", BORN))
    keeper = keeping(liveblocks, files)
    await keeper.ensure("entry")

    typing = Doc()
    typing["content"] = Text()
    typing.apply_update(liveblocks.documents["entry"])
    typing["content"] += "not stored yet"
    await liveblocks.send("entry", typing.get_update())

    files.held = Held("hello\nfrom a script\n", WROTE)
    files.history = {BORN: "hello\n"}
    await keeper.ensure("entry")

    said = liveblocks.text("entry")
    assert "not stored yet" in said
    assert said.count("from a script") == 1


async def test_two_arrivals_at_a_cold_room_seed_it_once():
    # The race the client's own election existed for. One keeper, one lock,
    # and the second arrival finds a room that is already filled.
    liveblocks = FakeLiveblocks()
    keeper = keeping(liveblocks, FakeFiles(Held("hello\n", BORN)))
    liveblocks.answering.clear()

    both = asyncio.gather(keeper.ensure("entry"), keeper.ensure("entry"))
    await asyncio.sleep(0)
    liveblocks.answering.set()
    await both

    assert liveblocks.text("entry") == "hello\n"
    assert liveblocks.sent == ["entry"]


async def test_different_entries_do_not_wait_on_each_other():
    liveblocks = FakeLiveblocks()
    keeper = keeping(liveblocks, FakeFiles(Held("hello\n", BORN)))
    liveblocks.answering.clear()

    both = asyncio.gather(keeper.ensure("one"), keeper.ensure("two"))
    await asyncio.sleep(0)
    liveblocks.answering.set()
    await both

    assert sorted(liveblocks.created) == ["one", "two"]


async def test_a_room_is_only_created_once_however_often_it_is_ensured():
    liveblocks = FakeLiveblocks()
    keeper = keeping(liveblocks, FakeFiles(Held("hello\n", BORN)))

    await keeper.ensure("entry")
    await keeper.ensure("entry")
    await keeper.ensure("entry")

    assert liveblocks.created == ["entry"]


async def test_a_file_that_is_not_text_is_left_without_a_room_to_fill():
    liveblocks = FakeLiveblocks()
    keeper = keeping(liveblocks, FakeFiles(None))

    await keeper.ensure("entry")

    assert liveblocks.sent == []
