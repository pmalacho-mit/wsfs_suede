/**
 * The offer of help that appears when a run ends badly.
 *
 * It withdraws itself the moment the person starts typing again, because
 * somebody who is editing is no longer stuck -- and an offer that outlives
 * the state it was describing is just something else to dismiss.
 */
import { toast } from "svelte-sonner";

/**
 * THE PROTOCOL'S OWN WORDING, and it is not decoration.
 *
 * "Looks like you're stuck" tells a student that a system has decided
 * something about them, which is a worse thing to read than an offer -- the
 * same argument `Workspace.svelte` makes about how the question is phrased
 * when they take it. What is being measured is whether they WANT help, and a
 * prompt that opens by diagnosing them is measuring something else.
 */
const OFFER = "Want a hint?";
const TAKE = "Yes, show me";

export class Nudge {
  #showing: string | number | undefined;

  /** Whether the offer is on screen right now. */
  get offered(): boolean {
    return this.#showing !== undefined;
  }

  /**
   * `forMs` rather than forever.
   *
   * A proactive prompt is meant to be small and non-blocking: it says its
   * piece and goes, whether or not anybody looked at it. One that waits
   * indefinitely stops being an offer and becomes something else on screen to
   * deal with -- and the protocol counts an ignored offer as an answer, which
   * it cannot do if the offer never ends.
   */
  offer(help: () => void, forMs = Number.POSITIVE_INFINITY) {
    this.withdraw();
    this.#showing = toast(OFFER, {
      duration: forMs,
      action: {
        label: TAKE,
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
