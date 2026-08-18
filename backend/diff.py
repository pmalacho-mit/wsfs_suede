from fast_diff_match_patch import diff


from typing import Iterable, Tuple, List, TypedDict, Required


class InsertOperation(TypedDict):
    insert: Required[str]


class RetainOperation(TypedDict):
    retain: Required[int]


class DeleteOperation(TypedDict):
    delete: Required[
        str
    ]  # yjs actually uses a number here, but using string for bidirectionality


type YjsDeltaOp = InsertOperation | RetainOperation | DeleteOperation
type Delta = list[YjsDeltaOp]


def utf16_len(s: str) -> int:
    # Count UTF-16 code units (to match Yjs indexing)
    return len(s.encode("utf-16-le")) // 2


def diff_to_delta(a: str, b: str, *, cleanup: str = "Efficiency") -> Delta:
    """
    Convert a→b using fast_diff_match_patch into Yjs-style ops.
    cleanup: "Semantic" | "Efficiency" | "No"
    """
    # counts_only=False returns (op, TEXT). With counts_only=True you'd only get lengths.
    parts: List[Tuple[str, str]] = diff(a, b, counts_only=False, cleanup=cleanup)
    delta: Delta = []

    def push(op: YjsDeltaOp):
        if not delta:
            delta.append(op)
            return
        last = delta[-1]
        if "retain" in op and "retain" in last:
            last["retain"] += op["retain"]  # type: ignore[index]
        elif "delete" in op and "delete" in last:
            last["delete"] += op["delete"]  # type: ignore[index]
        elif "insert" in op and "insert" in last:
            last["insert"] += op["insert"]  # type: ignore[index]
        else:
            delta.append(op)

    for tag, text in parts:
        if tag == "=" and text:
            push({"retain": utf16_len(text)})
        elif tag == "-" and text:
            push({"delete": text})
        elif tag == "+" and text:
            push({"insert": text})
    return delta


def apply_delta(base: str, delta: Delta, *, validate: bool = True) -> str:
    """
    Apply `delta` to `base` and return the new text.

    Invariants:
    - retain N copies the next N characters from `base`
    - insert S appends S to output (does not advance base pointer)
    - delete S skips len(S) characters in `base`
      (optionally validates that skipped text equals S when validate=True)
    """
    i = 0  # index into base
    out_parts: list[str] = []

    for op in delta:
        if "retain" in op:
            n = op["retain"]
            if n < 0:
                raise ValueError("retain must be non-negative")
            if i + n > utf16_len(base):
                raise ValueError(
                    f"delete text mismatch: expected {s!r}, found {base[i:i+n]!r}"
                )
            out_parts.append(base[i : i + n])
            i += n

        elif "insert" in op:
            s = op["insert"]
            out_parts.append(s)

        elif "delete" in op:
            s = op["delete"]
            n = utf16_len(s)
            if i + n > utf16_len(base):
                raise ValueError("delete goes past end of base")
            if validate:
                # ensure we're deleting exactly what we claim
                if base[i : i + n] != s:
                    raise ValueError(
                        f"delete text mismatch: expected {s!r}, found {base[i:i+n]!r}"
                    )
            i += n

        else:
            raise ValueError(f"Unknown op: {op!r}")

    # Any remaining base after ops is implicitly discarded (by definition of delta).
    # If you prefer to force full consumption, assert i == len(base).
    out_parts.append(base[i:])  # keep the tail if not explicitly deleted
    return "".join(out_parts)


def apply_deltas(base: str, deltas: Iterable[Delta], *, validate: bool = True) -> str:
    current = base
    for d in deltas:
        current = apply_delta(current, d, validate=validate)
    return current


def invert_delta(delta: Delta) -> Delta:
    inv: Delta = []
    for op in delta:
        if "retain" in op:
            inv.append({"retain": op["retain"]})
        elif "insert" in op:
            inv.append({"delete": op["insert"]})
        elif "delete" in op:
            inv.append({"insert": op["delete"]})
        else:
            raise ValueError(f"Unknown op: {op!r}")
    return inv


def recover_base(
    current: str, deltasOldestToNewest: Iterable[Delta], *, validate: bool = True
) -> str:
    """
    Given the final `current` text and the exact series of `deltas`
    that transformed the base into `current`, reconstruct the base.

    Implementation: for deltas [d1, d2, ..., dn],
    compute inverses [inv(dn), ..., inv(d2), inv(d1)] and apply them in that order.
    """
    # materialize once in case `deltas` is a generator
    seq = list(deltasOldestToNewest)
    text = current
    for d in reversed(seq):
        inv = invert_delta(d)
        text = apply_delta(text, inv, validate=validate)
    return text
