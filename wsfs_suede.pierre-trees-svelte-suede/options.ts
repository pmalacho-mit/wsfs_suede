import type {
  FileTreeDragAndDropConfig,
  FileTreeOptions,
  FileTreeRenamingConfig,
} from "@pierre/trees";
import type { Emitter } from "./events";

/**
 * Where these announcements go. Narrower than `Emitter` on purpose: the model
 * puts itself in the middle of this, so a draft's events can be held back
 * before anything subscribed ever sees them.
 */
export type Announce = Pick<Emitter, "emit">;

export type Options = FileTreeOptions;

const relay =
  <Args extends unknown[]>(
    announce: (...args: Args) => void,
    original: ((...args: Args) => void) | undefined,
  ) =>
  (...args: Args): void => {
    announce(...args);
    original?.(...args);
  };

const configWhenEnabled = <Config extends object>(
  toggle: boolean | Config | undefined,
): Config | undefined => {
  if (toggle === true) return {} as Config;
  if (toggle === false || toggle === undefined) return undefined;
  return toggle;
};

const announcingRenames = (
  renaming: Options["renaming"],
  emitter: Announce,
): FileTreeRenamingConfig | undefined => {
  const config = configWhenEnabled(renaming);
  if (config === undefined) return undefined;
  return {
    ...config,
    onRename: relay(
      (event) => emitter.emit("renamed", event),
      config.onRename,
    ),
    onError: relay(
      (error) => emitter.emit("rename refused", error),
      config.onError,
    ),
  };
};

const announcingDrops = (
  dragAndDrop: Options["dragAndDrop"],
  emitter: Announce,
): FileTreeDragAndDropConfig | undefined => {
  const config = configWhenEnabled(dragAndDrop);
  if (config === undefined) return undefined;
  return {
    ...config,
    onDropComplete: relay(
      (event) => emitter.emit("dropped", event),
      config.onDropComplete,
    ),
    onDropError: relay(
      (error, context) => emitter.emit("drop refused", error, context),
      config.onDropError,
    ),
  };
};

export const announcing = (options: Options, emitter: Announce): Options => ({
  ...options,
  onSelectionChange: relay(
    (paths) => emitter.emit("selection changed", paths),
    options.onSelectionChange,
  ),
  onSearchChange: relay(
    (value) => emitter.emit("search changed", value),
    options.onSearchChange,
  ),
  renaming: announcingRenames(options.renaming, emitter),
  dragAndDrop: announcingDrops(options.dragAndDrop, emitter),
});
