import type { EditableFile } from "../models.svelte";
import {
  chainedDocument,
  originOf,
  preludeOffset,
  type Cell,
} from "./chain";
import type { ChainedDocuments } from "./protocol";
import type { Notebook } from "./models.svelte";

type Placement = { notebook: Notebook; cell: EditableFile };

type Notifier = {
  sendNotification: (method: string, params: unknown) => Promise<void>;
};

const touch = (uri: string) => ({
  textDocument: { uri, version: 0 },
  contentChanges: [],
});

/**
 * Knows which document URIs are notebook cells, and answers the questions the
 * protocol rewriter asks about them.
 */
export class Notebooks {
  private notebooks = new Set<Notebook>();

  constructor(private readonly toUri: (path: string) => { toString: () => string }) {}

  add(notebook: Notebook) {
    this.notebooks.add(notebook);
    return () => this.notebooks.delete(notebook);
  }

  documents: ChainedDocuments = {
    offset: (uri) => this.withPreceding(uri, preludeOffset),
    document: (uri) =>
      this.withPlacement(uri, ({ notebook, cell }) =>
        chainedDocument(this.preceding(notebook, cell), cell.source),
      ),
    origin: (uri, line) =>
      this.withPreceding(uri, (preceding) => originOf(preceding, line)),
  };

  /**
   * A cell's analysed document contains every earlier cell, so editing one
   * invalidates all of the cells that follow it.
   */
  resyncAfter = (notebook: Notebook, cell: EditableFile, client: Notifier) =>
    Promise.all(
      notebook.cells
        .slice(notebook.cells.indexOf(cell) + 1)
        .map((later) =>
          client.sendNotification(
            "textDocument/didChange",
            touch(this.uriOf(later)),
          ),
        ),
    );

  private uriOf = (cell: EditableFile) => this.toUri(cell.path).toString();

  private locate(uri: string): Placement | undefined {
    for (const notebook of this.notebooks) {
      const cell = notebook.cells.find((candidate) => this.uriOf(candidate) === uri);
      if (cell) return { notebook, cell };
    }
    return undefined;
  }

  private preceding = (notebook: Notebook, cell: EditableFile): Cell[] =>
    notebook.before(cell).map((earlier) => ({
      uri: this.uriOf(earlier),
      text: earlier.source,
    }));

  private withPlacement = <T>(uri: string, read: (placement: Placement) => T) => {
    const placement = this.locate(uri);
    return placement === undefined ? undefined : read(placement);
  };

  private withPreceding = <T>(uri: string, read: (preceding: Cell[]) => T) =>
    this.withPlacement(uri, ({ notebook, cell }) =>
      read(this.preceding(notebook, cell)),
    );
}
