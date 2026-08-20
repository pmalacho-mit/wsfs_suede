/**
 * Currently only support text (string) file overrides,
 * with the direction intention of handling when a yjs-backed editor is concurrently open.
 */
export type FileOverride = {
  /**
   * @returns string if the override is activite for the `entry` / `path`, otherwise undefined
   */
  get: (path: string) => string | undefined;
  /**
   * @returns true if the override is active for the `path`
   */
  put: (path: string, value: string) => boolean;
};
