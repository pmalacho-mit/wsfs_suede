/**
 * The wire, spoken.
 *
 * Nothing here decides anything. It is handed where the router is mounted and
 * how to authenticate, because both belong to whoever mounted it, and it
 * turns the generated shapes into requests.
 */
import type { Held } from "./content";
import type { Id, Response, Snapshot, StreamEvent, Submitted, Version } from "./contract";

export type Authorized = () => HeadersInit | Promise<HeadersInit>;

export type Reading = {
  /** Any traffic at all, heartbeats included -- what a watchdog is armed on. */
  alive: () => void;
  event: (event: StreamEvent) => void;
  failed: (reason: unknown) => void;
};

export type Subscription = { close: () => void };

export type Transport = {
  initialize: (workspace: Id, outbox: Submitted[]) => Promise<Snapshot>;
  submit: (workspace: Id, request: Submitted) => Promise<Response>;
  content: (workspace: Id, entry: Id, version?: Version) => Promise<Held>;
  store: (digest: string, bytes: Uint8Array, mime: string) => Promise<void>;
  follow: (workspace: Id, token: string, reading: Reading) => Subscription;
};

const REFUSED = 409;

const json = async <T>(response: Response_) => (await response.json()) as T;

type Response_ = globalThis.Response;

const held = async (response: Response_): Promise<Held> => {
  const mime = response.headers.get("content-type") ?? "application/octet-stream";
  if (!mime.startsWith("application/json")) {
    return { kind: "binary", bytes: new Uint8Array(await response.arrayBuffer()), mime };
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

export const http = (base: string, authorize: Authorized): Transport => {
  const at = (path: string) => `${base.replace(/\/$/, "")}${path}`;
  const workspaces = (workspace: Id) => `/workspaces/${workspace}`;

  const send = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(at(path), {
      ...init,
      headers: { ...(await authorize()), ...(init.headers ?? {}) },
    });
    if (!response.ok && response.status !== REFUSED) {
      throw new Error(`${init.method ?? "GET"} ${path}: ${response.status}`);
    }
    return response;
  };

  const posted = (path: string, body: unknown) =>
    send(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  return {
    initialize: async (workspace, outbox) =>
      json<Snapshot>(await posted(`${workspaces(workspace)}/initialize`, { outbox })),

    submit: async (workspace, request) =>
      json<Response>(await posted(`${workspaces(workspace)}/transactions`, request)),

    content: async (workspace, entry, version) => {
      const query = version === undefined ? "" : `?content=${version}`;
      return held(await send(`${workspaces(workspace)}/entries/${entry}/content${query}`));
    },

    store: async (digest, bytes, mime) => {
      await send(`/blobs/${digest}`, {
        method: "PUT",
        headers: { "content-type": mime, "content-length": String(bytes.byteLength) },
        body: bytes as BodyInit,
      });
    },

    follow: (workspace, token, reading) => {
      const controller = new AbortController();
      void (async () => {
        try {
          const response = await fetch(
            at(`${workspaces(workspace)}/stream?token=${token}`),
            { headers: await authorize(), signal: controller.signal },
          );
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
