import { Setting } from "./setting";

export const y2Row = (y: number) => {
  const fname = y < 0 ? "ceil" : "floor";
  return Math[fname](y / Setting.font.height);
};

export const x2Col = (x: number) => {
  const fname = x < 0 ? "ceil" : "floor";
  return Math[fname](x / Setting.font.width);
};

export const row2Y = (row: number) => {
  return row * Setting.font.height;
};

export const col2X = (col: number) => {
  return col * Setting.font.width;
};

export const between = (min: number, val: number, max: number) => {
  return min <= val && val <= max;
};
