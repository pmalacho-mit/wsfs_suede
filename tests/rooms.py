"""What a shared room owes its file, and the updates that settle it."""

from pycrdt import Doc, Map, Text

from wsfs_suede.samples.backend.rooms import (
    Carry,
    Change,
    Held,
    Rebase,
    Seed,
    Settled,
    Standing,
    carried,
    plan,
    rebased,
    seeded,
    standing_of,
)

BORN = "01a02361-dad9-755a-ba88-e651f1ad637a"
WROTE = "01a02361-e423-71aa-ad9b-f4bd66c1aeb1"


def reading(update: bytes) -> tuple[str, str | None]:
    """A browser's view of an update, through the names the client uses."""
    doc = Doc()
    doc["content"] = Text()
    doc["standing"] = Map()
    doc.apply_update(update)
    return str(doc["content"]), doc["standing"].get("base")


def a_room(text: str = "", base: str | None = None, produced: list[str] = []) -> bytes:
    doc = Doc()
    doc["content"] = Text(text)
    doc["standing"] = Map({"base": base} if base is not None else {})
    doc["produced"] = Map({one: True for one in produced})
    return doc.get_update()


# -- what a room owes ------------------------------------------------------------------


def test_a_room_nobody_has_filled_is_seeded():
    assert plan(Standing(text="", base=None), Held("hello\n", BORN)) == Seed(
        text="hello\n", version=BORN
    )


def test_an_empty_file_is_seeded_once_and_then_left_alone():
    # Emptiness is not the question -- a file is allowed to be empty, and a room
    # judged by its text would be re-seeded for as long as it stayed that way.
    assert plan(Standing(text="", base=BORN), Held("", BORN)) == Settled()


def test_a_room_standing_where_the_file_stands_owes_nothing():
    assert plan(Standing(text="hello\n", base=WROTE), Held("hello\n", WROTE)) == Settled()


def test_a_write_the_room_made_itself_only_moves_the_version():
    # The doubling bug, relocated. Carrying text a room already holds inserts
    # it a second time, and a CRDT has no way to notice the two say the same
    # thing. The room says which writes are its own.
    assert plan(
        Standing(text="hello\nmine\n", base=BORN, produced=frozenset({WROTE})),
        Held("hello\nmine\n", WROTE),
    ) == Rebase(version=WROTE)


def test_a_room_that_already_says_what_the_file_says_only_moves_the_version():
    # The second guard, for a write whose bookkeeping has not arrived yet.
    assert plan(
        Standing(text="hello\nmine\n", base=BORN),
        Held("hello\nmine\n", WROTE),
    ) == Rebase(version=WROTE)


def test_a_room_left_behind_carries_the_gap():
    assert plan(Standing(text="hello\n", base=BORN), Held("hello\nmore\n", WROTE)) == Carry(
        since=BORN, version=WROTE
    )


def test_unstored_work_in_the_room_does_not_make_it_behind():
    # The room holding more than the file is the ordinary state of somebody
    # typing. Only the tokens decide.
    assert plan(Standing(text="hello\ntyping", base=WROTE), Held("hello\n", WROTE)) == Settled()


# -- reading a room --------------------------------------------------------------------


def test_a_room_reads_back_as_what_was_put_in_it():
    assert standing_of(a_room("hello\n", BORN)) == Standing(text="hello\n", base=BORN)


def test_a_room_reports_the_writes_it_made_itself():
    assert standing_of(a_room("hello\n", BORN, produced=[WROTE])).produced == frozenset({WROTE})


def test_a_room_that_has_never_been_written_has_no_base():
    assert standing_of(a_room()) == Standing(text="", base=None)


def test_a_room_with_no_document_at_all_has_no_base():
    assert standing_of(b"") == Standing(text="", base=None)


# -- seeding ---------------------------------------------------------------------------


def test_a_seed_carries_the_text_and_the_version_it_was_taken_at():
    assert reading(seeded("hello\n", BORN)) == ("hello\n", BORN)


def test_seeding_twice_does_not_say_it_twice():
    doc = Doc()
    doc["content"] = Text()
    doc["standing"] = Map()
    once = seeded("hello\n", BORN)
    doc.apply_update(once)
    doc.apply_update(once)
    assert str(doc["content"]) == "hello\n"


def test_moving_the_version_leaves_the_text_alone():
    live = a_room("hello\nmine\n", BORN)
    doc = Doc()
    doc["content"] = Text()
    doc["standing"] = Map()
    doc.apply_update(live)
    doc.apply_update(rebased(live, WROTE))
    assert str(doc["content"]) == "hello\nmine\n"
    assert doc["standing"]["base"] == WROTE


# -- carrying an outside write ---------------------------------------------------------


def test_a_carried_write_reaches_the_room():
    live = a_room("hello\n", BORN)
    update = carried(live, Change(before="hello\n", after="hello\nfrom a script\n"), WROTE)
    doc = Doc()
    doc["content"] = Text()
    doc["standing"] = Map()
    doc.apply_update(live)
    doc.apply_update(update)
    assert str(doc["content"]) == "hello\nfrom a script\n"
    assert doc["standing"]["base"] == WROTE


def test_carrying_keeps_work_the_file_has_never_seen():
    # The diff is between two STORED versions, so it describes only what the
    # other writer did. Diffing from the room instead would call this user's
    # unstored typing text to delete.
    typed = Doc()
    typed["content"] = Text()
    typed["standing"] = Map()
    typed.apply_update(a_room("hello\n", BORN))
    typed["content"] += "still typing"

    live = typed.get_update()
    update = carried(live, Change(before="hello\n", after="hello\nfrom a script\n"), WROTE)
    typed.apply_update(update)

    said = str(typed["content"])
    assert "still typing" in said
    assert said.count("from a script") == 1


def test_a_carried_write_lands_once_however_often_it_arrives():
    live = a_room("hello\n", BORN)
    update = carried(live, Change(before="hello\n", after="hello\nfrom a script\n"), WROTE)
    doc = Doc()
    doc["content"] = Text()
    doc["standing"] = Map()
    doc.apply_update(live)
    doc.apply_update(update)
    doc.apply_update(update)
    assert str(doc["content"]).count("from a script") == 1


def test_carrying_nothing_writes_nothing_but_the_version():
    live = a_room("hello\n", BORN)
    update = carried(live, Change(before="hello\n", after="hello\n"), WROTE)
    doc = Doc()
    doc["content"] = Text()
    doc["standing"] = Map()
    doc.apply_update(live)
    doc.apply_update(update)
    assert str(doc["content"]) == "hello\n"
    assert doc["standing"]["base"] == WROTE


def a_typing_room(base_text: str, base: str, typed: str, at: int) -> Doc:
    doc = Doc()
    doc["content"] = Text()
    doc["standing"] = Map()
    doc.apply_update(a_room(base_text, base))
    doc["content"].insert(at, typed)
    return doc


def test_a_change_lands_where_it_belongs_after_someone_typed_above_it():
    doc = a_typing_room("one\ntwo\nthree\n", BORN, typed="zero\n", at=0)
    doc.apply_update(
        carried(
            doc.get_update(),
            Change(before="one\ntwo\nthree\n", after="one\nTWO\nthree\n"),
            WROTE,
        )
    )
    assert str(doc["content"]) == "zero\none\nTWO\nthree\n"


def test_a_change_lands_where_it_belongs_after_someone_typed_below_it():
    doc = a_typing_room("one\ntwo\nthree\n", BORN, typed="four\n", at=len("one\ntwo\nthree\n"))
    doc.apply_update(
        carried(
            doc.get_update(),
            Change(before="one\ntwo\nthree\n", after="ONE\ntwo\nthree\n"),
            WROTE,
        )
    )
    assert str(doc["content"]) == "ONE\ntwo\nthree\nfour\n"


def test_a_deletion_is_carried_too():
    doc = a_typing_room("one\ntwo\nthree\n", BORN, typed="zero\n", at=0)
    doc.apply_update(
        carried(
            doc.get_update(),
            Change(before="one\ntwo\nthree\n", after="one\nthree\n"),
            WROTE,
        )
    )
    assert str(doc["content"]) == "zero\none\nthree\n"
