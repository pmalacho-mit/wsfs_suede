import { EditableFile } from "../models.svelte";

let created = 0;

const nextCellName = () => `cell-${++created}.py`;

/**
 * An ordered list of Python fragments that share one namespace, the way the
 * cells of a Jupyter notebook do. Each cell is an ordinary editable file so
 * that it can be opened by the same editor as any other source.
 */
export class Notebook {
  path: string;
  cells: EditableFile[];

  constructor({ path }: Pick<Notebook, "path">) {
    this.path = $state(path);
    this.cells = $state([]);
  }

  add(
    source: string | Pick<EditableFile, "source" | "sourceSync"> = "",
    at = this.cells.length,
  ) {
    const cell = new EditableFile({
      name: nextCellName(),
      parent: this,
      source: typeof source === "string" ? source : source.source,
      sourceSync: typeof source === "string" ? undefined : source.sourceSync,
    });
    this.cells.splice(at, 0, cell);
    return cell;
  }

  remove(cell: EditableFile) {
    this.cells = this.cells.filter((candidate) => candidate !== cell);
  }

  move(cell: EditableFile, to: number) {
    const from = this.cells.indexOf(cell);
    if (from < 0) return;
    this.cells.splice(from, 1);
    this.cells.splice(to, 0, cell);
  }

  before(cell: EditableFile) {
    return this.cells.slice(0, this.cells.indexOf(cell));
  }
}
