export type Cell = { uri: string; text: string };

export type Origin = { uri: string; line: number };

const lineCount = (text: string) => text.split("\n").length;

const preludeOf = (preceding: Cell[]) =>
  preceding.map((cell) => `${cell.text}\n`).join("");

const offsetOf = (preceding: Cell[]) =>
  preceding.reduce((total, cell) => total + lineCount(cell.text), 0);

const cellContaining = (preceding: Cell[], line: number): Origin | undefined => {
  let remaining = line;
  for (const cell of preceding) {
    const height = lineCount(cell.text);
    if (remaining < height) return { uri: cell.uri, line: remaining };
    remaining -= height;
  }
  return undefined;
};

/**
 * A notebook cell is analysed as its own document prefixed with every earlier
 * cell, which is how a name bound in one cell becomes visible in the next.
 * Everything the prefix shifts is expressed here as line arithmetic.
 */
export const chainedDocument = (preceding: Cell[], text: string) =>
  preludeOf(preceding) + text;

export const preludeOffset = offsetOf;

export const originOf = cellContaining;
