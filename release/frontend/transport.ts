/**
 * The wire, spoken.
 *
 * Nothing here decides anything. It is handed where the router is mounted and
 * how to authenticate, because both belong to whoever mounted it, and it
 * turns the generated shapes into requests.
 */
import { jittered } from "./loop";
import type { Payload } from "./content";
import type {
  History,
  Id,
  Response,
  Snapshot,
  StreamEvent,
  Submitted,
  Transaction,
  Version,
  Answering,
  Asked,
  Asking,
  Judged,
  Judging,
  Transcript,
  Accepted,
  Detected,
  Recorded,
} from "./contract";

export type Authorized = () => HeadersInit | Promise<HeadersInit>;

/**
 * Get a token that works, having just been told the last one did not.
 *
 * Optional, and what it is for is the case `Authorized` cannot cover: a token
 * that looked live to the client and was refused anyway -- a clock adrift, a
 * signing key changed under a running server, a session ended somewhere else.
 * False means there is no getting one, and the refusal stands.
 */
export type Reauthorized = () => Promise<boolean>;

const REFUSED_AUTH = 401;

export type Reading = {
  /** Any traffic at all, heartbeats included -- what a watchdog is armed on. */
  alive: () => void;
  event: (event: StreamEvent) => void;
  failed: (reason: unknown) => void;
};

export type Subscription = { close: () => void };

export type Transport = {
  initialize: (workspace: Id, outbox: Submitted[]) => Promise<Snapshot>;
  /**
   * `keepalive` is for the last write of a session, made as the page is going
   * away. An ordinary fetch is cancelled along with the document that made
   * it, so the work a person typed in the seconds before they closed the tab
   * never leaves the machine -- see `Workspace.rescue`. Bodies are capped at
   * 64KB across all in-flight keepalive requests, which is why it is the
   * exception and not the rule.
   */
  submit: (
    workspace: Id,
    request: Submitted,
    options?: { keepalive?: boolean },
  ) => Promise<Response>;
  content: (workspace: Id, entry: Id, version?: Version) => Promise<Payload>;
  store: (
    workspace: Id,
    digest: string,
    bytes: Uint8Array,
    mime: string,
  ) => Promise<void>;
  cleared: (workspace: Id, transactions: Transaction[]) => Promise<void>;
  /**
   * The collaboration room for one entry, as this host serves it.
   *
   * ON THE TRANSPORT, with everything else that talks to the server. These
   * were bare `fetch` calls to a path built by hand, which is how they went
   * on calling routes that had moved -- and, once found, how they went on
   * calling them without the caller's authorisation. One door, one base URL,
   * one auth story.
   */
  settleRoom: (workspace: Id, entry: Id) => Promise<Version | null>;
  warmRoom: (workspace: Id, entry: Id) => Promise<void>;
  roomStored: (workspace: Id, entry: Id, version: Version) => Promise<void>;
  handOver: (workspace: Id, entry: Id, update: Uint8Array) => Promise<void>;
  /** What this file has said, newest first, as far back as `before`. */
  history: (
    workspace: Id,
    entry: Id,
    asking: { before?: string; limit?: number },
  ) => Promise<History>;
  follow: (workspace: Id, token: string, reading: Reading) => Subscription;
  /** Put a question to the tutor, and be told where to hear the answer. */
  ask: (workspace: Id, asking: Asking) => Promise<Asked>;
  /**
   * The answer, delta by delta, until it ends.
   *
   * An async iterator rather than a subscription, because unlike the event
   * stream this one ENDS, and a caller wants to await the end of it. Read with
   * `fetch` for the same reason the event stream is -- see `read` below -- and
   * for one more: `EventSource` reconnects on its own, and a reconnect here
   * would replay an answer somebody has already read.
   */
  hear: (workspace: Id, token: string) => AsyncIterable<Answering>;
  /** Whether a program has moved toward its goal since a few minutes ago. */
  progress: (workspace: Id, asking: Judging) => Promise<Judged>;
  /** This person's conversation here, newest first. */
  conversation: (
    workspace: Id,
    asking: { before?: string; limit?: number },
  ) => Promise<Transcript>;
  /**
   * The study's three write-only routes.
   *
   * POSTED AND FORGOTTEN. Everything else on this transport is somebody's
   * work and is retried until it lands; these are a study's observations, and
   * the trade is the other way round -- see `study.py`. The promises still
   * reject, so a caller that wants to know can look; nothing in this codebase
   * does anything but ignore them.
   *
   * `keepalive` is for the last flush of a window, which happens as a page is
   * going away: an ordinary fetch is cancelled with the document, and ten
   * minutes of recording would be lost at the last hurdle.
   */
  detected: (workspace: Id, told: Detected) => Promise<void>;
  accepted: (workspace: Id, told: Accepted) => Promise<void>;
  activity: (
    workspace: Id,
    told: Recorded,
    options?: { keepalive?: boolean },
  ) => Promise<void>;
};

const REFUSED = 409;

const json = async <T>(response: Response_) => (await response.json()) as T;

type Response_ = globalThis.Response;

/**
 * Statuses that mean "not now", as opposed to "not ever".
 *
 * 429 and 503 are a server declining work it could do -- the admission gate
 * in front of the connection pool answers 503 -- and 502/504 are a proxy
 * saying it never got an answer. 408 is a request that ran out of time.
 *
 * 500 IS DELIBERATELY ABSENT. It means the server broke, not that it is
 * busy, and the overwhelming majority of those are deterministic: sending the
 * same request twice more produces the same traceback twice more, three log
 * lines where one would have done, and no better outcome for anybody.
 */
const TRANSIENT = new Set([408, 425, 429, 502, 503, 504]);

/**
 * Methods safe to send again with no thought about what the first one did.
 *
 * A POST is not on this list and gets no retry unless its call site says so,
 * because most of the ones here happen to be replayable and one is not:
 * asking the tutor twice starts answering twice. Opting in per route is what
 * makes that a decision somebody made rather than one they inherited -- and a
 * route added later gets the safe behaviour by not thinking about it.
 */
const REPLAYABLE_BY_METHOD = new Set(["GET", "HEAD", "PUT"]);

export type Sending = RequestInit & {
  /**
   * Whether sending this again can do no harm beyond the sending.
   *
   * Defaults to what the method implies. Set it on a POST whose effect is
   * named by something the CLIENT minted -- a transaction id, a content
   * hash, an update carrying its own identity -- because the server records
   * that unchanged and a second copy lands on the same thing as the first.
   */
  replayable?: boolean;
};

export type Retrying = {
  /** Requests sent, including the first. */
  attempts: number;
  minDelayMs: number;
  maxDelayMs: number;
};

/**
 * Deliberately shorter than `loop.ts`'s ladder. That backoff is for a stream
 * nobody is waiting on and can afford to reach thirty seconds. This one runs
 * inside a call somebody made -- a file being opened, a save going out -- so
 * the whole ladder has to fit inside the time a person will sit looking at a
 * spinner. Three retries at 250/500/1000ms is about a second and a half.
 */
export const RETRYING: Retrying = {
  attempts: 4,
  minDelayMs: 250,
  maxDelayMs: 4_000,
};

/**
 * Said at the call sites that mean it, so the reason is next to the request
 * rather than in a table somewhere else.
 */
const REPLAYABLE = { replayable: true } as const;

const sleep = (ms: number) => new Promise<void>((wake) => setTimeout(wake, ms));

const stopped = (signal?: AbortSignal | null) => signal?.aborted === true;

/**
 * How long the server asked to be left alone, if it said.
 *
 * Both spellings the header allows: seconds, and an HTTP date. A server that
 * has bothered to say knows more about when it will be ready than any local
 * guess does, so this wins over the backoff whenever it is longer.
 */
const askedFor = (response: Response_ | undefined) => {
  const said = response?.headers.get("retry-after");
  if (!said) return undefined;
  const seconds = Number(said);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const when = Date.parse(said);
  return Number.isNaN(when) ? undefined : Math.max(0, when - Date.now());
};

const held = async (response: Response_): Promise<Payload> => {
  const mime =
    response.headers.get("content-type") ?? "application/octet-stream";
  if (!mime.startsWith("application/json")) {
    return {
      kind: "binary",
      bytes: new Uint8Array(await response.arrayBuffer()),
      mime,
    };
  }
  const body = (await response.json()) as { content: string };
  return { kind: "text", text: body.content };
};

/**
 * SSE read with `fetch` rather than `EventSource`, for two reasons.
 *
 * `EventSource` reconnects on its own, and it reconnects to the same URL --
 * which carries a token that was spent the first time. Every reconnection has
 * to go back through Initialize for a fresh one.
 *
 * And `EventSource` drops comment lines, so the heartbeats are invisible to
 * it. A watchdog armed on messages alone cannot tell a quiet workspace from a
 * proxy quietly eating the stream, which is the exact failure it is for.
 */
const read = async (body: ReadableStream<Uint8Array>, reading: Reading) => {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let pending = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    reading.alive();
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      reading.event(JSON.parse(line.slice("data: ".length)) as StreamEvent);
    }
  }
};

export const http = (
  base: string,
  authorize: Authorized,
  reauthorize?: Reauthorized,
  retrying: Retrying = RETRYING,
): Transport => {
  const at = (path: string) => `${base.replace(/\/$/, "")}${path}`;
  const workspaces = (workspace: Id) => `/workspaces/${workspace}`;

  const once = async (path: string, init: RequestInit) =>
    fetch(at(path), {
      ...init,
      headers: { ...(await authorize()), ...(init.headers ?? {}) },
    });

  /**
   * A request, sent again if it was refused for its token or met a server
   * that was not ready for it.
   *
   * TWO RESENDS, FOR TWO DIFFERENT REASONS, and they compose rather than
   * share a budget.
   *
   * A 401 is resent once, whatever the method. That is safe for anything: a
   * request refused for its token was refused BEFORE it did anything, so the
   * second cannot repeat an effect the first had. Without it, a client whose
   * session had quietly lapsed spent its loop presenting the same dead token
   * until somebody reloaded the page.
   *
   * A transient failure -- no answer at all, or one of `TRANSIENT` -- is
   * resent up to `RETRYING.attempts`, backing off and JITTERED, and only if
   * the request is replayable. The jitter is the point rather than a detail:
   * a server sheds load when many clients want it at once, so a fixed delay
   * would gather exactly those clients into a second wave the same size as
   * the first. Spreading them is what turns shedding into recovery instead of
   * into a slower oscillation.
   *
   * A response that is merely a refusal the CALLER should see -- a 409, a
   * 403, a 404 -- is not a failure of the request and is handed back or
   * thrown immediately. Retrying those would only delay the answer.
   */
  const send = async (path: string, { replayable, ...init }: Sending = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const mayReplay = replayable ?? REPLAYABLE_BY_METHOD.has(method);
    const refused = () => new Error(`${method} ${path}: ${status ?? "no answer"}`);

    let reauthorized = false;
    let sent = 0;
    let status: number | undefined;

    for (;;) {
      let response: Response_ | undefined;
      let broke: unknown;
      try {
        response = await once(path, init);
        status = response.status;
      } catch (reason) {
        // An abort is the caller changing its mind, not the server failing.
        if (stopped(init.signal)) throw reason;
        broke = reason;
        status = undefined;
      }

      if (response?.status === REFUSED_AUTH && !reauthorized) {
        reauthorized = true;
        if (await reauthorize?.()) continue; // outside the retry budget
      }
      if (response && (response.ok || response.status === REFUSED)) {
        return response;
      }
      if (response && !TRANSIENT.has(response.status)) throw refused();

      // Nothing will read this body. Cancelling it hands the connection back
      // now rather than whenever the collector gets to it, which matters
      // most in exactly the case that produced it: a server short of them.
      void response?.body?.cancel().catch(() => undefined);

      sent += 1;
      if (!mayReplay || sent >= retrying.attempts || stopped(init.signal)) {
        throw response ? refused() : broke;
      }

      const backoff = Math.min(
        retrying.minDelayMs * 2 ** (sent - 1),
        retrying.maxDelayMs,
      );
      /**
       * The server's number is a FLOOR, and the jitter goes above it.
       *
       * Jittering the way the backoff is jittered would return 50-100% of it,
       * so `Retry-After: 2` would be honoured by coming back after one second
       * -- which is not honouring it, and the gate that sent it is still
       * draining. Spreading is still wanted, so it is added rather than
       * multiplied: the wait is never shorter than asked and never identical
       * across clients.
       */
      const told = askedFor(response);
      await sleep(
        told === undefined
          ? jittered(backoff)
          : told + Math.random() * Math.min(told, retrying.maxDelayMs),
      );
      if (stopped(init.signal)) throw response ? refused() : broke;
    }
  };

  const posted = (path: string, body: unknown, init: Sending = {}) =>
    send(path, {
      ...init,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  return {
    initialize: async (workspace, outbox) =>
      json<Snapshot>(
        /**
         * NOT replayable, though it plainly is: `loop.ts` already re-enters
         * Initialize on every failure, backing off 500ms to 30s and resetting
         * only once a stream is established. Retrying here as well would send
         * four Initializes per loop cycle instead of one -- quadrupling
         * demand in the window a shedding server least wants it, and putting
         * the outbox on the wire four times to learn the same thing.
         *
         * The stream is left out of `send` entirely for the same reason.
         */
        await posted(`${workspaces(workspace)}/initialize`, { outbox }),
      ),

    submit: async (workspace, request, { keepalive = false } = {}) =>
      json<Response>(
        await posted(`${workspaces(workspace)}/transactions`, request, {
<<<<<<< HEAD
=======
          ...REPLAYABLE,
>>>>>>> bc2290ca58dd09ae3f8a67582f76c23d4649fa23
          keepalive,
        }),
      ),

    cleared: async (workspace, transactions) => {
      await posted(
        `${workspaces(workspace)}/drafts/cleared`,
        { transactions },
        REPLAYABLE,
      );
    },

    settleRoom: async (workspace, entry) =>
      (
        await json<{ base: Version | null }>(
          await posted(`${workspaces(workspace)}/rooms/${entry}`, {}, REPLAYABLE),
        )
      ).base,

    warmRoom: async (workspace, entry) => {
      await posted(`${workspaces(workspace)}/rooms/${entry}/warm`, {}, REPLAYABLE);
    },

    roomStored: async (workspace, entry, version) => {
      await posted(
        `${workspaces(workspace)}/rooms/${entry}/stored`,
        { version },
        REPLAYABLE,
      );
    },

    handOver: async (workspace, entry, update) => {
      await send(`${workspaces(workspace)}/rooms/${entry}/updates`, {
        ...REPLAYABLE,
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: update as BodyInit,
      });
    },

    ask: async (workspace, asking) =>
      json<Asked>(await posted(`${workspaces(workspace)}/chat`, asking)),

    hear: async function* (workspace, token) {
      const response = await send(
        `${workspaces(workspace)}/chat/stream?token=${encodeURIComponent(token)}`,
      );
      if (response.body === null) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const said = JSON.parse(line.slice("data: ".length)) as Answering;
          yield said;
          /**
           * Read no further once it has ended. Nothing follows it, and
           * holding the body open would hold a connection for nothing.
           */
          if (said.type === "ended") {
            await reader.cancel().catch(() => undefined);
            return;
          }
        }
      }
    },

    progress: async (workspace, asking) =>
      json<Judged>(await posted(`${workspaces(workspace)}/progress`, asking)),

    detected: async (workspace, told) => {
      await posted(`${workspaces(workspace)}/study/episodes`, told);
    },

    accepted: async (workspace, told) => {
      await posted(`${workspaces(workspace)}/study/offers`, told);
    },

    activity: async (workspace, told, { keepalive = false } = {}) => {
      await posted(`${workspaces(workspace)}/study/activity`, told, {
        keepalive,
      });
    },

    conversation: async (workspace, { before, limit }) => {
      const asked = new URLSearchParams();
      if (before !== undefined) asked.set("before", before);
      if (limit !== undefined) asked.set("limit", String(limit));
      return json<Transcript>(
        await send(`${workspaces(workspace)}/chat?${asked.toString()}`),
      );
    },

    history: async (workspace, entry, { before, limit }) => {
      const asked = new URLSearchParams();
      if (before !== undefined) asked.set("before", before);
      if (limit !== undefined) asked.set("limit", String(limit));
      return json<History>(
        await send(
          `${workspaces(workspace)}/entries/${entry}/history?${asked.toString()}`,
        ),
      );
    },

    content: async (workspace, entry, version) => {
      const query = version === undefined ? "" : `?content=${version}`;
      return held(
        await send(`${workspaces(workspace)}/entries/${entry}/content${query}`),
      );
    },

    store: async (workspace, digest, bytes, mime) => {
      await send(`${workspaces(workspace)}/blobs/${digest}`, {
        method: "PUT",
        headers: {
          "content-type": mime,
          "content-length": String(bytes.byteLength),
        },
        body: bytes as BodyInit,
      });
    },

    follow: (workspace, token, reading) => {
      const controller = new AbortController();
      void (async () => {
        try {
          const stream = `${workspaces(workspace)}/stream?token=${token}`;
          const opened = () =>
            once(stream, { signal: controller.signal });
          /**
           * The stream is not sent through `send`: a 401 here is not retried
           * in place, because the token in the URL was minted by an
           * Initialize that has already happened. Re-authorising is still
           * worth doing -- the loop comes round to Initialize in a moment,
           * and it should find a live token when it gets there.
           */
          let response = await opened();
          if (response.status === REFUSED_AUTH && (await reauthorize?.())) {
            response = await opened();
          }
          if (!response.ok || response.body === null) {
            throw new Error(`stream: ${response.status}`);
          }
          reading.alive();
          await read(response.body, reading);
          reading.failed(new Error("stream ended"));
        } catch (reason) {
          if (!controller.signal.aborted) reading.failed(reason);
        }
      })();
      return { close: () => controller.abort() };
    },
  };
};
