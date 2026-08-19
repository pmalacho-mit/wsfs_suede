/**
 * What the browser tests need and the app does not.
 *
 * Everything here is about WAITING. A workspace is a network round trip and a
 * stream event behind every gesture, so a browser test that asserts
 * immediately is asserting on the optimistic view -- which is exactly the
 * thing worth distinguishing from the confirmed one.
 */
import { Open, project } from "$lib/workspace.svelte";

export const until = async (
  what: string,
  holds: () => boolean,
  /** What the world looked like instead. A timeout that only says which
   * condition failed sends you back to the browser to find out why. */
  instead?: () => string,
  within = 10_000,
): Promise<void> => {
  const deadline = Date.now() + within;
  while (!holds()) {
    if (Date.now() > deadline) {
      const saw = instead ? ` -- saw ${instead()}` : "";
      throw new Error(`timed out waiting for ${what}${saw}`);
    }
    await new Promise((wake) => setTimeout(wake, 25));
  }
};

/**
 * Every element under `root`, INCLUDING the ones inside open shadow roots.
 *
 * The tree is a custom element and draws its rows in a shadow root, so a
 * plain `querySelectorAll` from the page finds nothing at all -- which reads
 * exactly like a tree that never rendered.
 */
const everything = (root: ParentNode): Element[] => {
  const found: Element[] = [];
  for (const element of root.querySelectorAll("*")) {
    found.push(element);
    if (element.shadowRoot) found.push(...everything(element.shadowRoot));
  }
  return found;
};

/**
 * The rows the tree is drawing, by the identity the tree itself gives them.
 *
 * Not by their text: a row renders its name more than once -- visible, and
 * again for measuring the truncation -- so `textContent` reads "notes.notes.
 * md md" and matches nothing. `data-item-path` is the tree's own answer to
 * "which entry is this row", which is the question being asked.
 */
const rows = (within: HTMLElement): HTMLElement[] =>
  everything(within).filter(
    (element) => element.getAttribute("data-type") === "item",
  ) as HTMLElement[];

const pathOf = (row: HTMLElement) => row.getAttribute("data-item-path") ?? "";

/**
 * A folder's row carries a trailing separator and a file's does not, so a
 * caller that knows the name need not know which it is looking at.
 */
export const rowFor = (within: HTMLElement, path: string): HTMLElement | undefined =>
  rows(within).find((row) => pathOf(row) === path || pathOf(row) === `${path}/`);

/** Every path the tree is drawing -- for saying what it drew instead. */
export const drawn = (within: HTMLElement): string[] =>
  [...new Set(rows(within).map(pathOf))].filter(Boolean);

/**
 * A second client in the same workspace -- another tab, or another person.
 * Assertions land here rather than on the client under test, because a client
 * showing its own optimistic work proves nothing about what was stored.
 */
export const alongside = (id: string, user = "grace@example.com") => new Open(id, user);

export const opened = async (user = "ada@example.com") => {
  const id = await project(user);
  return { id, workspace: new Open(id, user) };
};
