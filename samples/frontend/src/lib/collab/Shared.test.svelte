<script lang="ts">
  /**
   * Two browsers, one workspace, one room each time.
   *
   * The same file runs in Chromium and in Firefox at once and each plays a
   * different part -- Ada types, Grace watches, or the other way about. They
   * agree on things at `/rendezvous` and nowhere else, because every other
   * channel between them is the thing under test.
   *
   * HOW THIS FAILS. The two browsers execute these in the same order, so
   * scenario N here pairs with scenario N there. A test that dies in one
   * browser leaves its partner waiting on a barrier nobody will reach, which
   * shows up as a timeout in the OTHER browser one test later. Read the first
   * failure, not the loudest.
   */
  import { Sweater } from "sweater-vest-suede";

  import { agree, announce, awaiting, browser, me, other, playing, step } from "./collaboration";
  import { Collaborator } from "./collaborator";

  /** How many times a body has run in this page -- see the converge test. */
  let bodies = 0;

  class Pocket {
    who = $state("");
    note = $state("");
    text = $state("");
  }

  /** One workspace for the whole run, agreed once by whoever asks first. */
  let shared: Promise<string> | undefined;
  const workspace = () =>
    (shared ??= (async () => {
      const answer = await fetch("/projects", {
        method: "POST",
        headers: { "X-User-Email": "ada@example.com" },
      });
      const mine = ((await answer.json()) as { id: string }).id;
      return agree("workspace", mine);
    })());

  const until = async (what: string, holds: () => boolean, within = 30_000) => {
    const deadline = Date.now() + within;
    while (!holds()) {
      if (Date.now() > deadline) throw new Error(`waited ${within}ms for ${what}`);
      await new Promise((carry) => setTimeout(carry, 100));
    }
  };

  /** A collaborator wired to the shared workspace, torn down with the test. */
  const joined = async (harness: any) => {
    const id = await workspace();
    const client = new Collaborator(me(), id);
    harness.onAbort(() => client.dispose());
    await until("the workspace to settle", () => client.workspace.index().paths().length >= 0);
    return client;
  };

  /**
   * Ada makes the file and says which it is; Grace waits to be told, then
   * waits again for her own stream to carry it. Both halves matter -- knowing
   * the id is not the same as the workspace having the entry.
   */
  const sharedFile = async (client: Collaborator, scenario: string, content = "") => {
    const id = await workspace();
    const key = step(id, scenario, "entry");
    const path = `${scenario}.py`;

    if (playing("ada")) {
      const { entry, settled } = client.workspace.create(path, content);
      await settled;
      await announce(key, entry);
    }
    const entry = await awaiting(key);
    await until(`${path} to arrive`, () => client.workspace.entries().has(entry));
    return entry;
  };
</script>

<Sweater config category="Collaboration" orientation="vertical" mode="serial" />

<Sweater
  name="converges when both type into one open file"
  body={async (harness) => {
    bodies += 1;
    const pocket = harness.set(new Pocket());
    pocket.who = browser();
    const client = await joined(harness);
    const entry = await sharedFile(client, "converge", "start\n");
    const id = await workspace();

    await client.open(entry);
    await until("the room to carry the file", () => client.text(entry).includes("start"));

    /**
     * Each writes their own line, at their own end. Concurrent inserts at one
     * point converge too, but which order they land in is the CRDT's business
     * and not something a test should be asserting about.
     */
    const mine = playing("ada") ? "ada was here\n" : "grace was here\n";
    const before = client.text(entry);
    client.type(entry, before + mine);
    const afterType = client.text(entry);
    await announce(step(id, "converge", `typed-${me()}`));
    await awaiting(step(id, "converge", `typed-${other()}`));

    await until(
      "both lines to arrive",
      () =>
        client.text(entry).includes("ada was here") &&
        client.text(entry).includes("grace was here"),
    );
    pocket.text = client.text(entry);

    /** And exactly once each -- the failure this whole design guards against. */
    const count = (needle: string) => pocket.text.split(needle).length - 1;
    if (count("ada was here") !== 1 || count("grace was here") !== 1)
      throw new Error(
        `[${browser()} ${me()} bodies=${bodies}] before=${JSON.stringify(before)} ` +
          `afterType=${JSON.stringify(afterType)} final=${JSON.stringify(pocket.text)}`,
      );
    harness.expect(count("ada was here")).toBe(1);
  }}
>
  {#snippet vest(pocket: Pocket)}
    <p><b>{pocket.who}</b></p>
    <pre>{pocket.text}</pre>
  {/snippet}
</Sweater>

<Sweater
  name="shows a late joiner what was typed before they opened it"
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    pocket.who = browser();
    const client = await joined(harness);
    const entry = await sharedFile(client, "latejoin", "");
    const id = await workspace();

    if (playing("ada")) {
      await client.open(entry);
      client.type(entry, "written before grace ever looked\n");
      const stored = await client.store(entry);
      harness.expect(stored.rejected).toBe(false);
      await announce(step(id, "latejoin", "stored"));
      pocket.note = "typed and stored";
    } else {
      await awaiting(step(id, "latejoin", "stored"));
      await client.open(entry);
      await until("the text to arrive", () =>
        client.text(entry).includes("written before grace"),
      );
      pocket.note = "saw it on opening";
    }
    pocket.text = client.text(entry);
    harness.expect(pocket.text.split("written before grace").length - 1).toBe(1);
  }}
>
  {#snippet vest(pocket: Pocket)}
    <p><b>{pocket.who}</b>: {pocket.note}</p>
    <pre>{pocket.text}</pre>
  {/snippet}
</Sweater>

<Sweater
  name="notices when somebody writes around the room"
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    pocket.who = browser();
    const client = await joined(harness);
    const entry = await sharedFile(client, "around", "one\n");
    const id = await workspace();

    if (playing("ada")) {
      /** Ada has it open, as a room. This is the client that must notice. */
      await client.open(entry);
      await until("the room to carry the file", () => client.text(entry).includes("one"));
      await announce(step(id, "around", "open"));

      await awaiting(step(id, "around", "written"));
      await until(
        "the room to be told it fell behind",
        () => client.verdicts.some((verdict) => verdict.kind === "repair"),
      );
      await until("the outside write to reach the room", () =>
        client.text(entry).includes("written by a script"),
      );
      pocket.note = "repaired";
    } else {
      /** Grace does NOT open it -- she writes the way a script would. */
      await awaiting(step(id, "around", "open"));
      await client.workspace.write("around.py", "one\nwritten by a script\n").settled;
      await announce(step(id, "around", "written"));
      pocket.note = "wrote around the room";
    }
    pocket.text = client.text(entry);
  }}
>
  {#snippet vest(pocket: Pocket)}
    <p><b>{pocket.who}</b>: {pocket.note}</p>
    <pre>{pocket.text}</pre>
  {/snippet}
</Sweater>

<Sweater
  name="does not call it a conflict when both store from the same room"
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    pocket.who = browser();
    const client = await joined(harness);
    const entry = await sharedFile(client, "bothstore", "shared\n");
    const id = await workspace();

    await client.open(entry);
    await until("the room to carry the file", () => client.text(entry).includes("shared"));
    await announce(step(id, "bothstore", `ready-${me()}`));
    await awaiting(step(id, "bothstore", `ready-${other()}`));

    /**
     * Both store at once, presenting the same token. One has to lose the
     * compare-and-swap -- and losing it must NOT look like a conflict, because
     * the two are already converged: the text that landed is the text both of
     * them are holding.
     */
    const stored = await client.store(entry);
    pocket.note = stored.rejected ? "lost the swap" : "landed";

    await until(
      "the stream to settle",
      () => client.verdicts.length > 0,
      15_000,
    ).catch(() => undefined);

    harness.expect(client.verdicts.some((verdict) => verdict.kind === "repair")).toBe(false);
  }}
>
  {#snippet vest(pocket: Pocket)}
    <p><b>{pocket.who}</b>: {pocket.note}</p>
  {/snippet}
</Sweater>
