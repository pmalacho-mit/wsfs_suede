/**
 * The transcript, as the panel shows it.
 *
 * Nothing here reaches a model. What it does hold is the shape a transport
 * will have to fill: a question, the files that were on screen when it was
 * asked, and a reply that arrives later than the question did -- which is
 * what the panel's loading and streaming states are drawn from.
 */
import type { ChatStatus } from "../shadcn/ai-elements/prompt-input";

export type Turn = {
  id: string;
  from: "user" | "assistant";
  text: string;
  /** The paths sent along with it. Only ever set on a question. */
  sent: string[];
};

/** How long the placeholder reply pretends to think. */
const THINKING_MS = 700;

const listed = (paths: string[]) =>
  paths.length === 0
    ? "You have no files open, so I would be answering from the question alone."
    : `I would be reading ${paths.length} open file${paths.length === 1 ? "" : "s"}:\n\n${paths
        .map((path) => `- \`${path}\``)
        .join("\n")}`;

const unwired = (sent: string[]) =>
  `${listed(sent)}\n\nThere is no assistant behind this panel yet — this reply is a placeholder so the transcript has something to draw.`;

export class Conversation {
  turns = $state<Turn[]>([]);
  status = $state<ChatStatus>("ready");

  #next = 0;
  #thinking: ReturnType<typeof setTimeout> | undefined;

  /** Asks, and schedules the placeholder that stands in for an answer. */
  ask(text: string, sent: string[]) {
    const asked = text.trim();
    if (asked === "" || this.status !== "ready") return;
    this.#say("user", asked, sent);
    this.status = "submitted";
    this.#thinking = setTimeout(() => {
      this.#say("assistant", unwired(sent), []);
      this.status = "ready";
    }, THINKING_MS);
  }

  /** Whether anything is waiting on a reply, which is what the loader shows. */
  get pending(): boolean {
    return this.status === "submitted" || this.status === "streaming";
  }

  dispose() {
    clearTimeout(this.#thinking);
    this.#thinking = undefined;
  }

  #say(from: Turn["from"], text: string, sent: string[]) {
    this.turns = [...this.turns, { id: `turn-${this.#next++}`, from, text, sent }];
  }
}
