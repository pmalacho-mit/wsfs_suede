<script lang="ts">
  /**
   * A long editing session, driven the way a person drives one, and then
   * asked the only question that matters: is anything missing.
   *
   * NOT A SCENARIO. The scenarios each pin one behaviour with one arrangement
   * they chose. This does the opposite: it picks its actions at random from
   * the ones a real session is made of -- typing, saving, losing the network,
   * losing the room, reloading the tab, restoring an old version -- and runs
   * hundreds of them. What it asserts is not that any particular thing
   * happened, but that after all of it:
   *
   *   1. the file holds what the last accepted write said it holds,
   *   2. every transaction this client ever got an answer for is one the
   *      server can still account for,
   *   3. nothing this client typed and was told was saved has gone.
   *
   * SEEDED, so a failure is a number somebody can put back in and watch
   * again. A soak test that cannot be replayed is a rumour.
   */
  import Sweater from "sweater-vest-suede/Sweater.svelte";
  import { Collaborator } from "./harness/collaboration";
  import { me } from "./harness/collaboration";
  import { project } from "./harness/testing.svelte";

  /**
   * Deterministic, and small on purpose: `Math.random()` would make every run
   * a different test and every failure unrepeatable.
   */
  const rolling = (seed: number) => {
    let held = seed >>> 0;
    return () => {
      held = (held * 1664525 + 1013904223) >>> 0;
      return held / 0x100000000;
    };
  };

  type Act = {
    what: string;
    /** What the file should say afterwards, if this changed it. */
    said?: string;
  };

  class Pocket {
    who = $state("");
    note = $state("");
    text = $state("");
    rounds = $state(0);
    log = $state<string[]>([]);
    verdict = $state("");
  }

  const wait = (ms: number) => new Promise((carry) => setTimeout(carry, ms));

  const until = async (
    what: string,
    ready: () => boolean | Promise<boolean>,
    within = 30_000,
    /** What was there instead, which is the only evidence a failure leaves. */
    seen?: () => string,
  ) => {
    const deadline = Date.now() + within;
    for (;;) {
      if (await ready()) return;
      if (Date.now() > deadline)
        throw new Error(
          `waited ${within}ms for ${what}${seen ? ` -- saw ${seen()}` : ""}`,
        );
      await wait(100);
    }
  };
</script>

<Sweater config category="Soak" orientation="vertical" mode="serial" />

<Sweater
  name="a long session of ordinary editing loses nothing"
  body={async (harness: any) => {
    const pocket: Pocket = harness.set(new Pocket());
    pocket.who = "one client, many rounds";

    const SEED = 20260824;
    const ROUNDS = 40;
    const roll = rolling(SEED);
    const pick = <T,>(from: T[]): T => from[Math.floor(roll() * from.length)]!;

    const id = await project("ada@example.com");
    let client = await Collaborator.opened(me(), id);
    harness.onAbort(() => client.dispose());

    const path = "soak.py";
    const made = client.workspace.create(path, "line 0\n");
    const entry = made.entry;
    await made.settled;

    /**
     * What this client believes the file says, and every transaction it was
     * ever told was accepted. The believed text only moves when the server
     * says a write landed -- a belief updated optimistically would agree with
     * the client by construction and prove nothing.
     */
    let believed = "line 0\n";
    const accepted: string[] = [made.transaction];
    const acted: Act[] = [];

    /** Ordinary typing, saved the way the editor saves. */
    const typeAndSave = async (at: number): Promise<Act> => {
      const next = `${believed}line ${at}\n`;
      const written = client.workspace.write(path, next);
      try {
        const answer = await written.settled;
        if (!answer.rejected) {
          believed = next;
          accepted.push(written.transaction);
          return { what: `typed line ${at}`, said: next };
        }
        return { what: `typed line ${at}, refused: ${answer.reason}` };
      } catch (reason) {
        /** The wire was down. Queued, and settled later or not at all. */
        return { what: `typed line ${at}, unsent` };
      }
    };

    /** The server goes away and comes back while the person keeps working. */
    const offlineSpell = async (at: number): Promise<Act> => {
      client.reachable(false);
      const next = `${believed}offline ${at}\n`;
      const written = client.workspace.write(path, next);
      void written.settled.catch(() => undefined);
      await wait(150);
      client.reachable(true);
      client.workspace.nudge();
      /**
       * Queued work leaves the outbox when the STREAM carries it, so this
       * waits for the file to actually say it rather than for the answer.
       */
      await until(`the offline write ${at} to land`, async () =>
        (await client.reads(entry)).includes(`offline ${at}`),
      );
      believed = next;
      accepted.push(written.transaction);
      return { what: `wrote ${at} with no server`, said: next };
    };

    /** The tab is closed and opened again, with the same storage under it. */
    const reload = async (): Promise<Act> => {
      await client.dispose();
      client = await Collaborator.opened(me(), id);
      harness.onAbort(() => client.dispose());
      await until("the workspace to come back", () =>
        client.workspace.entries().has(entry),
      );
      return { what: "reloaded the tab" };
    };

    /** Somebody asks for an older version back. */
    const restore = async (): Promise<Act> => {
      const { versions } = await client.workspace.history(entry, { limit: 10 });
      const older = versions.filter(
        (one) => one.standing === "applied" && one.kind === "text",
      );
      if (older.length < 2) return { what: "nothing old enough to restore" };
      const wanted = older[older.length - 1]!;
      const held = await client.workspace.at(entry, wanted.transaction);
      if (held.kind !== "text") return { what: "that version was not text" };
      const { settled } = await client.workspace.restore(
        entry,
        wanted.transaction,
      );
      const answer = await settled;
      if (answer.rejected) return { what: `restore refused: ${answer.reason}` };
      believed = held.text;
      return { what: "restored an older version", said: held.text };
    };

    for (let round = 0; round < ROUNDS; round += 1) {
      const act = pick(["type", "type", "type", "offline", "reload", "restore"]);
      const done =
        act === "type"
          ? await typeAndSave(round)
          : act === "offline"
            ? await offlineSpell(round)
            : act === "reload"
              ? await reload()
              : await restore();
      acted.push(done);
      pocket.rounds = round + 1;
      pocket.log = [...acted.slice(-6).map((one) => one.what)];

      /**
       * Checked EVERY round rather than once at the end. A soak test that
       * only looks afterwards can say something broke; one that looks as it
       * goes can say which round broke it.
       */
      if (done.said !== undefined) {
        await until(
          `the file to say what round ${round} wrote`,
          async () => (await client.reads(entry)) === done.said,
        );
      }
    }

    /** 1. The file holds what the last accepted change said it holds. */
    const finally_ = await client.reads(entry);
    harness.expect(finally_).toBe(believed);

    /**
     * 2. Everything answered is still accounted for. `unsettled` is the
     * client's own question -- of these transactions, which has the server
     * not written down -- and an empty answer is what makes a snapshot of
     * this session portable to anybody else.
     */
    await until(
      "every accepted transaction to be settled",
      () => client.workspace.unsettled(accepted).length === 0,
      60_000,
    );
    harness.expect(client.workspace.unsettled(accepted)).toEqual([]);

    /**
     * 3. And the server can still hand back what this client was looking at,
     * which is the question the whole design exists to answer.
     */
    await client.take(entry);
    await client.rebuildable();

    pocket.verdict = `${ROUNDS} rounds, ${accepted.length} accepted, nothing missing`;
  }}
>
  {#snippet vest(pocket: Pocket)}
    <div class="p-3 font-mono text-xs">
      <p><b>{pocket.who}</b> — round {pocket.rounds}</p>
      <p>{pocket.verdict}</p>
      <ul>
        {#each pocket.log as line}
          <li>{line}</li>
        {/each}
      </ul>
    </div>
  {/snippet}
</Sweater>

<script lang="ts" module>
  import {
    agree,
    announce,
    awaiting,
    browser,
    other,
    playing,
    step,
  } from "./harness/collaboration";
</script>

<Sweater
  name="two people typing into one file lose nothing between them"
  body={async (harness: any) => {
    /**
     * The claim collaboration has to make, put under load: everything either
     * person typed is in the file at the end.
     *
     * Each round both append a line only they write, so a lost edit is a
     * missing line rather than a subtle difference somebody has to squint at
     * -- and the CRDT is what has to make both survive, since neither client
     * ever sees the other's line before writing its own.
     *
     * The network is taken away from one of them as they work, because that
     * is when merging is actually hard: an edit made while detached arrives
     * after edits that were made later.
     */
    const pocket: Pocket = harness.set(new Pocket());
    pocket.who = browser();

    const ROUNDS = 12;
    const id = await agree("soak-pair", `pair-${Date.now()}`);
    const workspaceId = await agree(
      "soak-pair-workspace",
      await project("ada@example.com"),
    );

    const client = await Collaborator.opened(me(), workspaceId);
    harness.onAbort(() => client.dispose());

    /** Ada makes the file; Grace waits to be told which it is. */
    const key = step(id, "pair", "entry");
    let entry: string;
    if (playing("ada")) {
      const made = client.workspace.create("pair.py", "start\n");
      await made.settled;
      entry = made.entry;
      await announce(key, entry);
    } else {
      entry = await awaiting(key);
    }
    await until(
      "the file to arrive",
      async () => client.workspace.entries().has(entry),
      30_000,
    );

    await client.open(entry);
    await until("the room to carry the file", () =>
      client.text(entry).includes("start"),
    );

    const mine = playing("ada") ? "ada" : "grace";
    for (let round = 0; round < ROUNDS; round += 1) {
      /**
       * Appended to what THIS client currently sees, which is the honest
       * thing an editor does -- neither of them waits to be told what the
       * other just typed.
       */
      /**
       * Zero-padded so no marker is a prefix of another: counting
       * occurrences of "ada 1" would also count "ada 10".
       */
      client.type(
        entry,
        `${client.text(entry)}${mine}-${String(round).padStart(2, "0")}\n`,
      );

      /** One of them loses the room for a round, alternately. */
      const detaching = round % 4 === (playing("ada") ? 1 : 3);
      if (detaching) client.goOffline(entry);

      await announce(step(id, "pair", `typed-${round}-${mine}`));
      await awaiting(step(id, "pair", `typed-${round}-${playing("ada") ? "grace" : "ada"}`));

      if (detaching) await client.comeBack(entry);

      /** Ada stores on even rounds, Grace on odd ones. */
      if (playing("ada") === (round % 2 === 0)) {
        await until("the room to speak", () => client.speaks(entry), 30_000);
        const stored = await client.store(entry);
        if (stored.held) pocket.note = `round ${round} kept: ${stored.why}`;
      }
      pocket.note = `round ${round} done`;
    }

    /** Everybody back, and everything shared. */
    await announce(step(id, "pair", "typed-everything"));
    await awaiting(step(id, "pair", "typed-everything"));

    const wanted: string[] = [];
    for (let round = 0; round < ROUNDS; round += 1)
      wanted.push(
        `ada-${String(round).padStart(2, "0")}`,
        `grace-${String(round).padStart(2, "0")}`,
      );

    await until(
      "every line either of them typed to be in this document",
      () => wanted.every((line) => client.text(entry).includes(line)),
      60_000,
      () =>
        `missing ${wanted.filter((line) => !client.text(entry).includes(line)).join(", ")}`,
    );

    /** And once it is stored, the FILE says all of it too. */
    await until("the room to speak", () => client.speaks(entry), 30_000);
    const stored = await client.store(entry);
    if (stored.held) throw new Error(`would not store: ${stored.why}`);
    await announce(step(id, "pair", `stored-${mine}`));
    await awaiting(step(id, "pair", `stored-${playing("ada") ? "grace" : "ada"}`));

    await until(
      "the file to hold every line",
      async () => {
        const held = await client.reads(entry);
        return wanted.every((line) => held.includes(line));
      },
      60_000,
    );

    /** Each line exactly once: merging twice is as bad as losing one. */
    const held = await client.reads(entry);
    for (const line of wanted)
      harness.expect(held.split(line).length - 1).toBe(1);

    pocket.text = held.split("\n").slice(0, 6).join("\n");
    pocket.verdict = `${wanted.length} lines, all present, none doubled`;
    await client.take(entry);
    await client.rebuildable();
  }}
>
  {#snippet vest(pocket: Pocket)}
    <div class="p-3 font-mono text-xs">
      <p><b>{pocket.who}</b> — {pocket.note}</p>
      <p>{pocket.verdict}</p>
      <pre>{pocket.text}</pre>
    </div>
  {/snippet}
</Sweater>
