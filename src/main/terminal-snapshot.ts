import type { IBuffer, IBufferCell, Terminal } from "@xterm/headless";

const MAX_SNAPSHOT_SIZE = 2 * 1024 * 1024;

function style(cell: IBufferCell) {
  const codes = [0];
  if (cell.isBold()) codes.push(1);
  if (cell.isDim()) codes.push(2);
  if (cell.isItalic()) codes.push(3);
  if (cell.isUnderline()) codes.push(4);
  if (cell.isBlink()) codes.push(5);
  if (cell.isInverse()) codes.push(7);
  if (cell.isInvisible()) codes.push(8);
  if (cell.isStrikethrough()) codes.push(9);
  if (cell.isOverline()) codes.push(53);
  for (const foreground of [true, false]) {
    const color = foreground ? cell.getFgColor() : cell.getBgColor();
    const rgb = foreground ? cell.isFgRGB() : cell.isBgRGB();
    const palette = foreground ? cell.isFgPalette() : cell.isBgPalette();
    if (rgb) codes.push(foreground ? 38 : 48, 2, color >> 16 & 255, color >> 8 & 255, color & 255);
    else if (palette) codes.push(foreground ? 38 : 48, 5, color);
  }
  return `\x1b[${codes.join(";")}m`;
}

function cursor(buffer: IBuffer, cols: number) {
  let col = Math.min(buffer.cursorX, cols - 1);
  if (buffer.cursorX < cols) return `\x1b[${buffer.cursorY + 1};${col + 1}H`;
  const line = buffer.getLine(buffer.baseY + buffer.cursorY);
  if (line?.getCell(col)?.getWidth() === 0) col--;
  const cell = line?.getCell(col);
  const position = `\x1b[${buffer.cursorY + 1};${col + 1}H`;
  if (!cell) return position;
  return position + style(cell) + (cell.getChars() || " ") + "\x1b[0m";
}

/** Reconstructs cells and scrollback from the resolved screen, keeping the newest rows within budget. */
function serializeBuffer(buffer: IBuffer, cols: number, budget: number) {
  const lines: { data: string; wrapped: boolean }[] = [];
  const cell = buffer.getNullCell();
  let size = 0;
  for (let row = buffer.length - 1; row >= 0; row--) {
    const line = buffer.getLine(row);
    if (!line) continue;
    let width = cols;
    if (!buffer.getLine(row + 1)?.isWrapped) {
      while (width > 0 && line.getCell(width - 1, cell) && !cell.getChars() && cell.isAttributeDefault()) width--;
      if (width < cols && line.getCell(width, cell)?.getWidth() === 0) width++;
    }
    let data = "";
    let previousStyle = "";
    for (let col = 0; col < width; col++) {
      if (!line.getCell(col, cell) || cell.getWidth() === 0) continue;
      const attributes = style(cell);
      if (attributes !== previousStyle) data += attributes;
      previousStyle = attributes;
      data += cell.getChars() || " ";
    }
    if (size + data.length > budget) break;
    lines.push({ data, wrapped: line.isWrapped });
    size += data.length + 2;
  }
  lines.reverse();
  let result = "";
  for (let row = 0; row < lines.length; row++) {
    if (row && !lines[row].wrapped) result += "\r\n";
    result += lines[row].data;
  }
  result += "\x1b[0m" + cursor(buffer, cols);
  return result;
}

/** A reload restores both buffers before live output resumes at its sequence watermark. */
export function serializeTerminal(screen: Terminal) {
  const alternate = screen.buffer.active.type === "alternate";
  let data = "\x1bc" + serializeBuffer(screen.buffer.normal, screen.cols, alternate ? MAX_SNAPSHOT_SIZE / 2 : MAX_SNAPSHOT_SIZE);
  if (alternate) data += "\x1b[?1049h\x1b[H" + serializeBuffer(screen.buffer.alternate, screen.cols, MAX_SNAPSHOT_SIZE / 2);
  const modes = screen.modes;
  const enabled = [
    [1, modes.applicationCursorKeysMode], [6, modes.originMode], [7, modes.wraparoundMode],
    [45, modes.reverseWraparoundMode], [66, modes.applicationKeypadMode],
    [1004, modes.sendFocusMode], [2004, modes.bracketedPasteMode],
  ] as const;
  for (const [code, value] of enabled) data += `\x1b[?${code}${value ? "h" : "l"}`;
  data += `\x1b[4${modes.insertMode ? "h" : "l"}`;
  const mouse = { none: 0, x10: 9, vt200: 1000, drag: 1002, any: 1003 }[modes.mouseTrackingMode];
  if (mouse) data += `\x1b[?${mouse}h`;
  const buffer = screen.buffer.active;
  data += cursor(buffer, screen.cols);
  return data;
}
