/**
 * Noticing that somebody is stuck, and deciding whether to say anything.
 *
 * Two halves, and keeping them apart is the point. DETECTING is a set of
 * rules about what a person has been doing; OFFERING is a study protocol laid
 * over the top -- a coin toss, a cooldown, a window -- which decides whether
 * a detection is allowed to become a prompt.
 *
 * EVERY DETECTION IS RECORDED, including the ones that never reach a screen.
 * A detection that was randomized into silence and one that arrived during a
 * cooldown are different facts about the same student, and an analysis that
 * only sees the prompts cannot tell either of them from a student who was
 * never stuck at all.
 *
 * NOTHING HERE READS A CLOCK OR TOSSES A COIN FOR ITSELF. Both are handed in,
 * so the twenty-minute cooldown is tested in twenty milliseconds and the coin
 * lands where the test says. A rule about time that can only be tested by
 * waiting is a rule nobody tests.
 */
import { mint } from "../../identity";

/** Why this person looks stuck. */
export type Rule = "the same error twice" | "idle" | "no progress";

/** What became of one detection. */
export type Became =
  | "offered"
  | "silent"
  | "held back by the cooldown"
  | "held back by a post-episode window";

/** A stretch of time an episode opened, both ends known when it opened. */
export type Span = { from: number; until: number };

export type Episode = {
  /**
   * This episode, named once and named everywhere.
   *
   * MINTED HERE, at detection, because everything downstream is ABOUT an
   * episode: the offer somebody accepted, the cooldown it started, the window
   * it opened, and every keystroke recorded inside that window. Without an id
   * chosen at the moment of detection, those are four tables that can only be
   * joined by guessing at timestamps.
   */
  id: string;
  at: number;
  rule: Rule;
  /** What the rule saw, in words, for whoever reads the log later. */
  detail: string;
  became: Became;
  /**
   * The program as it stood when this was detected.
   *
   * Undefined when nothing was on screen to describe -- which is a real state
   * and not an error, and is why it is not the empty string.
   */
  code?: { entry?: string; path: string; text: string };
  /** The post-episode window this one opened, if it was eligible to open one. */
  window?: Span;
  /** The cooldown a shown prompt started. Absent for every silent episode. */
  cooldown?: Span;
};

export type Settings = {
  /** No action at all for this long. */
  idle: number;
  /** How often to ask whether the code has moved toward its goal. */
  progress: number;
  /** The share of eligible episodes that are offered a prompt. */
  offerRate: number;
  /** After a prompt is SHOWN, how long before another may be. */
  cooldown: number;
  /** After any eligible episode, how long before another may be counted. */
  window: number;
  /** How long the prompt stays on screen. */
  banner: number;
};

const SECOND = 1_000;

export const DEFAULTS: Settings = {
  idle: 180 * SECOND,
  progress: 240 * SECOND,
  offerRate: 0.5,
  cooldown: 20 * 60 * SECOND,
  window: 10 * 60 * SECOND,
  banner: 20 * SECOND,
};

/**
 * The settings, with anything the URL says on top.
 *
 * Every one of these is a number somebody will want to change without a
 * deploy -- to watch the protocol work in a minute rather than half an hour,
 * or to run a term at a different rate. Seconds rather than milliseconds
 * because that is what the person typing the URL is thinking in; the rate is
 * the one exception, being a share rather than a duration.
 */
export const settingsFrom = (
  search: string,
  base: Settings = DEFAULTS,
): Settings => {
  const asked = new URLSearchParams(search);
  /**
   * ASKED FOR EXPLICITLY, because `Number(null)` is zero and zero is a
   * perfectly good number of seconds. Reading a missing parameter as a value
   * turned every default into 0 -- an idle threshold of nothing, and a nudge
   * on every tick.
   */
  const said = (name: string) => {
    const raw = asked.get(name);
    if (raw === null || raw.trim() === "") return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };
  const seconds = (name: keyof Settings, held: number) => {
    const value = said(`nudge.${name}`);
    return value !== undefined && value >= 0 ? value * SECOND : held;
  };
  const rate = said("nudge.offer");
  return {
    idle: seconds("idle", base.idle),
    progress: seconds("progress", base.progress),
    cooldown: seconds("cooldown", base.cooldown),
    window: seconds("window", base.window),
    banner: seconds("banner", base.banner),
    offerRate: rate !== undefined && rate >= 0 && rate <= 1 ? rate : base.offerRate,
  };
};

/** The longest a pass over the time rules is worth waiting for. */
const SLOWEST_TICK = 5 * SECOND;
/** And the shortest, so `nudge.idle=0` cannot spin the page. */
const FASTEST_TICK = 250;

/**
 * How often to ask the time-based rules, GIVEN what they are set to.
 *
 * A fixed five seconds is fine for a three-minute rule and useless for a
 * four-second one: somebody testing the protocol with `?nudge.idle=4` sets a
 * threshold the tick cannot resolve, watches nothing happen on the schedule
 * they asked for, and concludes the setting does nothing. Half the shortest
 * rule means the answer is never more than half a threshold late, whatever
 * the threshold is.
 */
export const tickFor = ({ idle, progress }: Settings): number =>
  Math.max(
    FASTEST_TICK,
    Math.min(SLOWEST_TICK, Math.max(idle, FASTEST_TICK) / 2, Math.max(progress, FASTEST_TICK) / 2),
  );

/**
 * The exception's name, which is what "the same error" means.
 *
 * The name alone and not the message: `NameError: x` and `NameError: y` are
 * the same mistake made twice, and a student who fixes one variable and trips
 * over the next is exactly the person this rule is for. Anchored at the start
 * because a traceback quotes the source line above it, and source lines
 * contain colons.
 */
export const errorNamed = (because: string): string | undefined =>
  /^([A-Za-z_][A-Za-z0-9_]*(?:Error|Exception|Interrupt|Exit|Iteration|Warning))\b/.exec(
    because.trim(),
  )?.[1];

export type Judging = (asking: {
  goal: string;
  before: string;
  after: string;
}) => Promise<{ progressing: boolean; why: string }>;

export type Looking = () =>
  | { entry?: string; path: string; text: string }
  | undefined;

export type Ran = { ok: boolean; because?: string };

type Wiring = {
  settings: Settings;
  /** Show the prompt. Called only for episodes randomized into `offered`. */
  offer: (episode: Episode, forMs: number) => void;
  /** Every detection, whatever became of it. */
  record?: (episode: Episode) => void;
  /** What the person is looking at, for the progress rule. */
  looking?: Looking;
  /** What a file is for, if anybody has said. See `goals.ts`. */
  goalFor?: (path: string) => string | undefined;
  /** Asks whether the code moved. Absent means the rule is off. */
  judging?: Judging;
  now?: () => number;
  /** In [0, 1). Handed in so a test can say which way the coin lands. */
  roll?: () => number;
  /** Names an episode. Handed in so a test can predict what it is called. */
  mint?: () => string;
};


export class Stuck {
  readonly settings: Settings;
  readonly episodes: Episode[] = [];

  #wiring: Wiring;
  #now: () => number;
  #roll: () => number;
  #mint: () => string;

  #acted: number;
  #lastError: string | undefined;
  /** The code when the progress clock last started, and when that was. */
  #since: { at: number; path: string; text: string } | undefined;
  #judging = false;
  #cooldownUntil = 0;
  #windowUntil = 0;
  #stopped = false;

  constructor(wiring: Wiring) {
    this.#wiring = wiring;
    this.settings = wiring.settings;
    this.#now = wiring.now ?? (() => Date.now());
    this.#roll = wiring.roll ?? Math.random;
    this.#mint = wiring.mint ?? mint;
    this.#acted = this.#now();
    this.#since = this.#current();
  }

  /**
   * The person did something -- ANYTHING.
   *
   * The idle rule is about a person, not about a pane, so this is called from
   * the editor, from the chat box, from the run button, from opening a file,
   * and from a plain keystroke or click anywhere in the workspace. The bar is
   * deliberately low: "idle" in the protocol means nobody is there, and a
   * student reading their own traceback, scrolling a file, or switching tabs
   * is there.
   */
  acted(): void {
    this.#acted = this.#now();
  }

  /** A program finished. Resets idleness and feeds the error rule. */
  ran(outcome: Ran): void {
    this.acted();
    if (outcome.ok) {
      this.#lastError = undefined;
      return;
    }
    const named = errorNamed(outcome.because ?? "");
    if (named === undefined) return;
    const again = this.#lastError === named;
    this.#lastError = named;
    if (!again) return;
    /**
     * Cleared after it fires, so three of the same error is two episodes
     * rather than one at the second run and another at the third -- the rule
     * is "twice", and a third is the next "twice".
     */
    this.#lastError = undefined;
    this.#consider("the same error twice", `${named} twice in a row`);
  }

  /**
   * The time-based rules, evaluated as often as the caller likes.
   *
   * Driven from outside rather than from a timer in here, so a test advances
   * a number instead of waiting. See the note at the top.
   */
  check(): void {
    if (this.#stopped) return;
    const at = this.#now();
    if (at - this.#acted >= this.settings.idle) {
      /** Re-armed, so a long silence is reported as it goes on rather than
       *  once and never again. */
      this.#acted = at;
      this.#consider("idle", `no action for ${Math.round(this.settings.idle / SECOND)}s`);
    }
    void this.#askWhetherItMoved(at);
  }

  stop(): void {
    this.#stopped = true;
  }

  /** For a caller that wants to show what has been noticed. */
  get lastEpisode(): Episode | undefined {
    return this.episodes.at(-1);
  }

  #current() {
    const held = this.#wiring.looking?.();
    return held === undefined
      ? undefined
      : { at: this.#now(), path: held.path, text: held.text };
  }

  async #askWhetherItMoved(at: number): Promise<void> {
    const { judging, goalFor, looking } = this.#wiring;
    if (judging === undefined || looking === undefined) return;
    if (this.#judging) return;

    const held = looking();
    if (held === undefined) return;

    const since = this.#since;
    /** A file the person only just opened has no "before" to compare with. */
    if (since === undefined || since.path !== held.path) {
      this.#since = { at, path: held.path, text: held.text };
      return;
    }
    if (at - since.at < this.settings.progress) return;

    const goal = goalFor?.(held.path);
    /** Re-armed whatever the answer is, so the next window starts here. */
    this.#since = { at, path: held.path, text: held.text };
    if (goal === undefined) return;

    this.#judging = true;
    try {
      const said = await judging({
        goal,
        before: since.text,
        after: held.text,
      });
      if (this.#stopped || said.progressing) return;
      this.#consider("no progress", said.why || `no progress on ${held.path}`);
    } catch {
      /** A judgement nobody could make is not evidence that anybody is
       *  stuck. The next window asks again. */
    } finally {
      this.#judging = false;
    }
  }

  /**
   * One detection, put through the protocol.
   *
   * ORDER MATTERS. The cooldown is longer than the window, so asking about
   * the window first would report "in a window" for the ten minutes they
   * overlap and hide the reason that actually applies for the other ten.
   */
  #consider(rule: Rule, detail: string): void {
    const at = this.#now();
    const seen = this.#wiring.looking?.();
    /**
     * The code snapshot goes on EVERY episode, including the ones the
     * protocol holds back. What a student's program looked like when they got
     * stuck is the fact; whether anybody spoke to them about it is the
     * treatment.
     */
    const of = (became: Became, spans: Partial<Episode> = {}): Episode => ({
      id: this.#mint(),
      at,
      rule,
      detail,
      became,
      ...(seen === undefined ? {} : { code: seen }),
      ...spans,
    });

    if (at < this.#cooldownUntil) {
      this.#write(of("held back by the cooldown"));
      return;
    }
    if (at < this.#windowUntil) {
      this.#write(of("held back by a post-episode window"));
      return;
    }

    const offered = this.#roll() < this.settings.offerRate;
    /**
     * The window opens for BOTH conditions, which is what makes the two
     * comparable: a silent episode is followed by the same ten minutes of
     * undisturbed behaviour as an offered one.
     */
    const window = { from: at, until: at + this.settings.window };
    this.#windowUntil = window.until;
    const cooldown = offered
      ? { from: at, until: at + this.settings.cooldown }
      : undefined;
    if (cooldown) this.#cooldownUntil = cooldown.until;

    const episode = this.#write(
      of(offered ? "offered" : "silent", {
        window,
        ...(cooldown === undefined ? {} : { cooldown }),
      }),
    );
    if (offered) this.#wiring.offer(episode, this.settings.banner);
  }

  #write(episode: Episode): Episode {
    this.episodes.push(episode);
    this.#wiring.record?.(episode);
    return episode;
  }
}
