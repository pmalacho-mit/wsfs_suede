/**
 * The wire, named.
 *
 * Every type here is the generated schema under a shorter name. Nothing is
 * declared by hand: if a shape drifts, `generate.py` moves it and this file
 * stops compiling, which is the point.
 */
import type { components } from "./schema.generated";

type Schemas = components["schemas"];

export type Id = string;
export type Version = string;
export type Transaction = string;

export type Metadata = Schemas["Metadata"];
export type Occurrence = Schemas["Occurrence"];
export type Type = Schemas["Type"];
export type Seen = Schemas["Seen"];

export type TextBody = Schemas["TextBody"];
export type BinaryBody = Schemas["BinaryBody"];
export type Body = TextBody | BinaryBody;

export type Create = Schemas["Create"];
export type Delete = Schemas["Delete"];
export type Rename = Schemas["Rename"];
export type Reparent = Schemas["Reparent"];
export type Move = Schemas["Move"];
export type Write = Schemas["Write"];

export type Submitted = Create | Delete | Rename | Reparent | Move | Write;

export type Initialize = Schemas["InitializeRequest"];
export type Snapshot = Schemas["InitializeResponse"];
export type Rejection = Schemas["Rejection"];

export type Versions = Schemas["Versions"];
export type Reconstructed = Schemas["Reconstructed"];
export type ReconstructionRequest = Schemas["ReconstructionRequest"];
export type ReconstructionResponse = Schemas["ReconstructionResponse"];

export type Event = Schemas["Event"];
export type StreamEvent = Schemas["StreamEvent"];

export type Response =
  | { rejected: false; draft?: boolean }
  | { rejected: true; reason: string; version?: Version | null };

/**
 * The one refusal that is not a conflict. A token the server never issued
 * means this client's state is unsound, and the only sound move is to throw it
 * away and re-Initialize rather than rebase onto something and retry.
 */
export const UNSOUND = "the version presented was never issued";

export const refused = (response: Response): response is Extract<Response, { rejected: true }> =>
  response.rejected;

/**
 * Recorded, and deliberately not made the file's content.
 *
 * Grouped with `refused` because of the one thing they share and nothing
 * else: NO STREAM EVENT WILL EVER FOLLOW EITHER, so both are answers the
 * outbox has to act on itself. What they mean could hardly be further apart --
 * a refusal is the system declining, a draft is this client asking.
 */
export const kept = (response: Response) => !response.rejected && response.draft === true;

/** Neither of which the stream will ever mention again. */
export const settledHere = (response: Response) => refused(response) || kept(response);

export const isFolder = (entry: Metadata) => entry.type === "folder";

export const isLive = (entry: Metadata) => !entry.deleted;

/** A create is the only request that carries no token to compare against. */
export const isCreate = (request: Submitted): request is Create =>
  request.op === "create";

export const isWrite = (request: Submitted): request is Write =>
  request.op === "write";
