/**
 * Open text files, and who to trust while one is open.
 *
 * The client used to hold this and no longer does, which is right: it cannot
 * know that a buffer exists, and it was contorting its read path around the
 * possibility. Whether a half-typed line beats the last accepted write is a
 * question only whoever put the editor on the screen can answer, so this is
 * where the answer lives.
 *
 * The answer here: a `Y.Doc` per open path, bound to monaco so keystrokes
 * merge rather than overwrite, flushed to the workspace on a debounce, and
 * consulted ahead of the workspace by anything reading meanwhile -- which is
 * how the kernel runs the file you are looking at rather than the file you
 * last saved.
 */
import * as Y from "yjs";

import { MappedDebouncer, type Held, type Path, type Workspace } from "$wsfs";

/** The name the shipped Liveblocks adapter gives the shared text. */
const TEXT = "content";

/** What an editor is handed: the text, and the type to bind to. */
export type Buffer = {
  text: () => string;
  /** Deliberately untyped here for the same reason the client left it so. */
  shared: unknown;
};

type Held_ = { doc: Y.Doc; text: Y.Text; readers: number };

export class Buffers {
  readonly #open = new Map<Path, Held_>();
  readonly #flushes = new MappedDebouncer<Path>({ idleMs: 400, maxWaitMs: 2_000 });
  readonly #workspace: Workspace;

  constructor(workspace: Workspace) {
    this.#workspace = workspace;
  }

  async open(path: Path): Promise<Buffer> {
    const already = this.#open.get(path);
    if (already) return (already.readers += 1), this.#buffer(already);

    const doc = new Y.Doc();
    const text = doc.getText(TEXT);
    // Seeded before anyone observes, so the seeding is not itself a write.
    const held = await this.#workspace.read(path);
    if (held?.kind === "text" && held.text.length > 0) text.insert(0, held.text);

    const entry: Held_ = { doc, text, readers: 1 };
    this.#open.set(path, entry);
    text.observe(() => this.#flushes.enqueue(path, () => this.#flush(path)));
    return this.#buffer(entry);
  }

  close(path: Path): void {
    const entry = this.#open.get(path);
    if (entry === undefined) return;
    entry.readers -= 1;
    if (entry.readers > 0) return;
    this.#flushes.flush(path);
    this.#open.delete(path);
    entry.doc.destroy();
  }

  /**
   * What an open buffer says, for a reader that would otherwise be told what
   * was last written. Nothing when the file is not open, which is when the
   * workspace's own answer is the best there is.
   */
  holding(path: Path): Held | undefined {
    const entry = this.#open.get(path);
    return entry === undefined ? undefined : { kind: "text", text: entry.text.toString() };
  }

  dispose(): void {
    this.#flushes.dispose({ flush: true });
    for (const entry of this.#open.values()) entry.doc.destroy();
    this.#open.clear();
  }

  #buffer(entry: Held_): Buffer {
    return { text: () => entry.text.toString(), shared: entry.text };
  }

  #flush(path: Path): void {
    const entry = this.#open.get(path);
    if (entry === undefined) return;
    void this.#workspace.write(path, entry.text.toString()).settled;
  }
}
