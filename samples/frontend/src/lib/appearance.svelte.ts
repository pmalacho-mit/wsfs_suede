/**
 * Which way the shell paints.
 *
 * The grid, the dock and the tree each draw their own chrome and each has to
 * be told; they live in different panels, so the answer cannot be a prop
 * threaded through one of them. One matcher, read by whoever needs it.
 */
import type { Theme } from "wsfs_suede.dockview-svelte-suede";

class Appearance {
  dark = $state(false);

  constructor() {
    if (typeof window === "undefined") return;
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    this.dark = scheme.matches;
    scheme.addEventListener("change", () => (this.dark = scheme.matches));
  }

  get theme(): Theme {
    return this.dark ? "githubDark" : "githubLight";
  }
}

export const appearance = new Appearance();
