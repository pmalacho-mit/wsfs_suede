/** A point, as the menu's anchoring wants it: a box with no size. */
export const pointAsRect = (x: number, y: number) => ({
  top: y,
  bottom: y,
  left: x,
  right: x,
  width: 0,
  height: 0,
  x,
  y,
});

