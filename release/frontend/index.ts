/**
 * A workspace filesystem, client side.
 *
 * One object holds the state; three adapters read it, so the tree, the editor
 * and the kernel cannot disagree about what a file contains.
 */
export { connect } from "./workspace";
export type { Options, Workspace } from "./workspace";

export { http } from "./transport";
export type { Authorized, Transport } from "./transport";

export { mint, session } from "./identity";
export { mintedAt, localised, accepted, offset, reading, written } from "./minted";
export type { Reading } from "./minted";
export { inMemory, digestOf } from "./bytes";
export type { Digest, Store } from "./bytes";

export type { Document, Open } from "./documents";
export type { Held } from "./content";
export type { Path, Index } from "./paths";
export type { View } from "./effective";

export * as contract from "./contract";
export { DEFAULTS as timing } from "./loop";
export type { Timing } from "./loop";

export { provider } from "./adapters/files";
export type { FileProvider } from "./adapters/files";
export { filesystem } from "./adapters/kernel";
export { mirror } from "./adapters/tree";
export { documents as liveblocks } from "./liveblocks";
export type { Joining } from "./liveblocks";
