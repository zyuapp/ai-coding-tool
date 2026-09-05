import assert from "node:assert/strict";
import { test } from "vitest";
import { Terminal } from "@xterm/headless";
import { serializeTerminal } from "../../src/main/terminal-snapshot.ts";

const write = (terminal: Terminal, data: string) => new Promise<void>((resolve) => terminal.write(data, resolve));
function text(terminal: Terminal) {
  const buffer = terminal.buffer.active;
  return Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(true));
}

test("terminal snapshots restore resolved progress, Unicode, colours, scrollback, and the live cursor", async () => {
  const source = new Terminal({ cols: 12, rows: 3, scrollback: 50, allowProposedApi: true });
  const target = new Terminal({ cols: 12, rows: 3, scrollback: 50, allowProposedApi: true });
  try {
    await write(source, "old\r\nprogress 10\rprogress 99\r\n\x1b[31m你好 red\x1b[0m\r\nprompt> ");
    await write(target, serializeTerminal(source));
    assert.deepEqual(text(target), text(source));
    assert.equal(target.buffer.active.cursorX, source.buffer.active.cursorX);
    assert.equal(target.buffer.active.cursorY, source.buffer.active.cursorY);
    const coloredRow = source.buffer.active.length - 2;
    assert.equal(target.buffer.active.getLine(coloredRow)?.getCell(0)?.getFgColor(), 1);
    await write(source, "next");
    await write(target, "next");
    assert.deepEqual(text(target), text(source));
  } finally { source.dispose(); target.dispose(); }
});

test("alternate-screen snapshots keep the normal screen and input modes on return", async () => {
  const source = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
  const target = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
  try {
    await write(source, "shell> \x1b[?1049h\x1b[?2004h\x1b[2;3Heditor");
    await write(target, serializeTerminal(source));
    assert.deepEqual(text(target), text(source));
    assert.equal(target.modes.bracketedPasteMode, true);
    await write(source, "!\x1b[?1049lback");
    await write(target, "!\x1b[?1049lback");
    assert.deepEqual(text(target), text(source));
  } finally { source.dispose(); target.dispose(); }
});

test("a snapshot at the right margin preserves wrapping when the next chunk arrives", async () => {
  const source = new Terminal({ cols: 12, rows: 3, allowProposedApi: true });
  const target = new Terminal({ cols: 12, rows: 3, allowProposedApi: true });
  try {
    await write(source, "123456789012");
    await write(target, serializeTerminal(source));
    await write(source, "next");
    await write(target, "next");
    assert.deepEqual(text(target), text(source));
  } finally { source.dispose(); target.dispose(); }
});

test("snapshots stay bounded when styled scrollback is full", async () => {
  const source = new Terminal({ cols: 100, rows: 24, scrollback: 5000, allowProposedApi: true });
  try {
    const line = Array.from({ length: 100 }, (_, index) => `\x1b[38;2;${index};0;0mx`).join("");
    await write(source, (line + "\r\n").repeat(5000));
    const data = serializeTerminal(source);
    assert.ok(data.length < 2 * 1024 * 1024 + 1000);
    assert.ok(data.endsWith("H"));
  } finally { source.dispose(); }
});
