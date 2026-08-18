import type { ContextMenuItem } from "@pierre/trees";
import type { Model } from "./model.svelte";

const placeholder = { file: "untitled", folder: "untitled/" } as const;

const parentOf = (path: string): string => {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const lastSlash = trimmed.lastIndexOf("/");
  return lastSlash < 0 ? "" : trimmed.slice(0, lastSlash + 1);
};

/** Both spellings of a path collide, so a directory can never shadow a file. */
const taken = (model: Model, path: string): boolean => {
  const alternate = path.endsWith("/") ? path.slice(0, -1) : `${path}/`;
  return model.item(path) !== null || model.item(alternate) !== null;
};

const numbered = (path: string, suffix: number): string => {
  if (path.endsWith("/")) return `${path.slice(0, -1)}-${suffix}/`;
  const dot = path.lastIndexOf(".");
  return dot > path.lastIndexOf("/")
    ? `${path.slice(0, dot)}-${suffix}${path.slice(dot)}`
    : `${path}-${suffix}`;
};

const vacant = (model: Model, path: string): string => {
  let suffix = 0;
  let candidate = path;
  while (taken(model, candidate)) candidate = numbered(path, ++suffix);
  return candidate;
};

/**
 * What a file explorer's menu does to the tree, given the item it was opened
 * on. New entries land inside a directory and beside a file, and open straight
 * into rename mode so the placeholder name is never what the user is left with.
 */
export const entries = {
  add(model: Model, item: ContextMenuItem, kind: "file" | "folder") {
    const directory = item.kind === "directory" ? item.path : parentOf(item.path);
    const path = vacant(model, `${directory}${placeholder[kind]}`);
    model.add(path);
    model.rename(path, { removeIfCanceled: true });
  },

  rename(model: Model, item: ContextMenuItem) {
    model.rename(item.path);
  },

  remove(model: Model, item: ContextMenuItem) {
    model.remove(item.path, { recursive: item.kind === "directory" });
  },
};
