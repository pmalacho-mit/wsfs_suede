/**
 * The offer of help that appears when a run ends badly.
 *
 * It withdraws itself the moment the person starts typing again, because
 * somebody who is editing is no longer stuck -- and an offer that outlives
 * the state it was describing is just something else to dismiss.
 */
import { toast } from "svelte-sonner";

const OFFER = "Looks like you're stuck, click here for some help";

export class Nudge {
  #showing: string | number | undefined;

  /** Whether the offer is on screen right now. */
  get offered(): boolean {
    return this.#showing !== undefined;
  }

  offer(help: () => void) {
    this.withdraw();
    this.#showing = toast(OFFER, {
      duration: Number.POSITIVE_INFINITY,
      action: {
        label: "Ask the assistant",
        onClick: () => {
          this.#showing = undefined;
          help();
        },
      },
      onDismiss: () => (this.#showing = undefined),
      onAutoClose: () => (this.#showing = undefined),
    });
  }

  withdraw() {
    if (this.#showing === undefined) return;
    toast.dismiss(this.#showing);
    this.#showing = undefined;
  }
}
