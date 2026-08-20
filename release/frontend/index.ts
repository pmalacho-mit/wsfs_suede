/**
 * A workspace filesystem, client side.
 *
 * One object holds the state and says what moved; three adapters read it, so
 * the tree, the editor and the kernel are looking at the same entries. What a
 * file contains WHILE somebody is typing into it is not decided here -- only
 * a consumer knows it has a buffer open, so preferring it is its rule to make.
 */
export { connect } from "./workspace";
export type { Changed, Creating, Options, Submitting, Workspace } from "./workspace";

/** What a `watch` listener is handed: one entry, one thing about it, and who. */
export type { Change, Watching } from "./changes";

export { http } from "./transport";
export type { Authorized, Transport } from "./transport";

export { mint, session } from "./identity";
export { inMemory, digestOf } from "./bytes";
export type { Digest, Store } from "./bytes";

export type { Held } from "./content";
export type { Path, Index } from "./paths";
export type { View } from "./effective";

export * as contract from "./contract";
export { DEFAULTS as timing } from "./loop";
export type { Timing } from "./loop";

export { provider } from "./adapters/files";
export type { FileProvider } from "./adapters/files";
export { filesystem } from "./adapters/kernel";
/**
 * Per-key debouncing, for a consumer that holds an open buffer and decides
 * when it becomes a write. This client no longer has an opinion about that.
 */
export { MappedDebouncer } from "./debounce";
