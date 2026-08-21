/**
 * Two browsers, one room.
 *
 * Everything about collaboration that matters is a claim about what happens
 * BETWEEN clients, and a single browser cannot make one. Two `Workspace`s in
 * one page share an origin, and the moment local persistence lands they share
 * an IndexedDB too -- so a suite that passed there would be proving something
 * about one client talking to itself.
 *
 * So the same suite runs in Chromium and in Firefox at once, and each test
 * plays a different part depending on which one it is in. `me()` is which.
 *
 * The two cannot tell each other anything directly -- that is the thing under
 * test -- so they meet on the host, at `/rendezvous`. Two primitives are
 * enough: agreeing on a value neither of them can pick alone, and waiting for
 * the other to say it has got somewhere.
 */

/** Stable, and few: the account is capped on how many users it may have. */
export const ADA = "ada@example.com";
export const GRACE = "grace@example.com";

export type Part = "ada" | "grace";

/**
 * Which browser this is, read off the report driver's own URL.
 *
 * The driver appends `?reportServer=<url>/<browser>` when it opens the page,
 * which makes the browser's name the one piece of identity already on hand --
 * no flag to pass, and nothing to keep in step with the runner.
 */
export const browser = (): string => {
  const reporting = new URL(location.href).searchParams.get("reportServer");
  const named = reporting?.split("/").filter(Boolean).pop();
  return named ?? "chromium";
};

/**
 * The part this browser plays. Chromium is Ada, everyone else is Grace.
 *
 * Arbitrary, and it has to be: what matters is only that the two browsers
 * disagree about who they are, so that a test can say "if I am Ada, type; if
 * I am Grace, wait and then check".
 */
export const me = (): Part => (browser() === "chromium" ? "ada" : "grace");

export const other = (): Part => (me() === "ada" ? "grace" : "ada");

export const emailOf = (part: Part) => (part === "ada" ? ADA : GRACE);

export const iAm = emailOf(me());

/** Whether this browser plays a given part -- the shape most tests branch on. */
export const playing = (part: Part) => me() === part;

const HOST = "";

/**
 * Propose a value; get back whatever the first proposal was.
 *
 * How the two browsers come to be in the same workspace at all. Both make one
 * and offer it; one of them is thrown away unused, which costs a row and
 * saves needing either browser to be told anything by the other.
 */
export const agree = async (key: string, candidate: string): Promise<string> => {
  const answer = await fetch(`${HOST}/rendezvous/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: candidate }),
  });
  if (!answer.ok) throw new Error(`rendezvous ${key}: ${answer.status}`);
  return ((await answer.json()) as { value: string }).value;
};

/** Say that something has happened, for the other browser to wait on. */
export const announce = (key: string, value = "done") => agree(key, value);

/**
 * Wait for the other browser to announce something.
 *
 * Polled rather than pushed, because a push would need a channel between the
 * two -- and every channel available is either the thing under test or another
 * thing that could be broken in the same way.
 */
export const awaiting = async (
  key: string,
  within = 30_000,
): Promise<string> => {
  const deadline = Date.now() + within;
  for (;;) {
    const answer = await fetch(`${HOST}/rendezvous/${encodeURIComponent(key)}`);
    if (answer.ok) return ((await answer.json()) as { value: string }).value;
    if (Date.now() > deadline)
      throw new Error(`waited ${within}ms for "${key}" and nobody arrived`);
    await new Promise((carry) => setTimeout(carry, 150));
  }
};

/**
 * A key nobody else's test will touch.
 *
 * Scoped by the suite's own agreed workspace, so two scenarios that both want
 * to say "I have finished typing" cannot hear each other.
 */
export const step = (workspace: string, scenario: string, name: string) =>
  `${workspace}:${scenario}:${name}`;
