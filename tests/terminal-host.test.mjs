import assert from "node:assert/strict";
import test from "node:test";
import { closeTerminal, readTerminal, startTerminal, startTerminalHost, stopTerminalHost, writeTerminal } from "../dist/main/main/terminal-host.js";

const loginShell = process.env.SHELL;
test.before(() => { if (process.platform !== "win32") process.env.SHELL = "/bin/sh"; });
test.after(() => { if (loginShell === undefined) delete process.env.SHELL; else process.env.SHELL = loginShell; });

function host() {
  const data = [];
  const updates = [];
  startTerminalHost({ onData: (event) => data.push(event), onUpdate: (update) => updates.push(update) });
  return { data, updates };
}

/** Polls rather than sleeping a fixed time, so a slow shell fails as a timeout instead of flaking. */
async function until(check, message) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(message);
}

const lines = (snapshot) => snapshot.lines.join("\n");

test("a shell runs what the user types, and a read returns it as plain text", async (t) => {
  const { updates } = host();
  t.after(() => stopTerminalHost());
  startTerminal("terminal-1", process.cwd());

  writeTerminal("terminal-1", "printf 'plain-%s\\n' output\r");

  const snapshot = await until(
    async () => {
      const read = await readTerminal("terminal-1", { lines: 100 });
      return lines(read).includes("plain-output") ? read : null;
    },
    "the shell never printed",
  );

  assert.equal(snapshot.omitted, 0);
  assert.equal(updates.some((update) => update.terminalId === "terminal-1" && update.status === "exited"), false);
});

test("what a read returns is what the screen shows, not the bytes that drew it", async (t) => {
  host();
  t.after(() => stopTerminalHost());
  startTerminal("terminal-2", process.cwd());

  writeTerminal("terminal-2", "printf 'progress 10%%\\rprogress 100%%\\n\\033[31mred-text\\033[0m\\n'\r");

  const snapshot = await until(
    async () => {
      const read = await readTerminal("terminal-2", { lines: 100 });
      return lines(read).includes("red-text") ? read : null;
    },
    "the shell never printed",
  );

  const text = lines(snapshot);
  assert.equal(text.includes("["), false, "escape sequences are resolved, not returned");
  assert.equal(text.includes("progress 10%\r"), false, "the overwritten progress line is gone");
  assert.match(text, /progress 100%/);
});

test("a filtered read keeps only matching lines and counts them", async (t) => {
  host();
  t.after(() => stopTerminalHost());
  startTerminal("terminal-3", process.cwd());

  writeTerminal("terminal-3", "printf 'info one\\nERROR two\\ninfo three\\nerror four\\n'\r");

  const snapshot = await until(
    async () => {
      const read = await readTerminal("terminal-3", { lines: 100, match: "error" });
      return read.matched >= 2 ? read : null;
    },
    "the shell never printed",
  );

  assert.equal(snapshot.lines.every((line) => line.toLowerCase().includes("error")), true);
  const unfiltered = await readTerminal("terminal-3", { lines: 100 });
  assert.ok(snapshot.lines.length < unfiltered.lines.length, "the lines that do not match are left out");
});

test("a read never returns more lines than it was asked for, and says how many it left out", async (t) => {
  host();
  t.after(() => stopTerminalHost());
  startTerminal("terminal-4", process.cwd());

  writeTerminal("terminal-4", "for i in $(seq 1 60); do echo line-$i; done\r");

  const snapshot = await until(
    async () => {
      const read = await readTerminal("terminal-4", { lines: 10 });
      return lines(read).includes("line-60") ? read : null;
    },
    "the shell never printed",
  );

  assert.equal(snapshot.lines.length, 10);
  assert.ok(snapshot.omitted > 0, "the lines the limit left out are counted");
});

test("output arrives coalesced rather than one message per write", async (t) => {
  const { data } = host();
  t.after(() => stopTerminalHost());
  startTerminal("terminal-5", process.cwd());

  writeTerminal("terminal-5", "for i in $(seq 1 300); do echo chunk-$i; done\r");
  await until(
    async () => lines(await readTerminal("terminal-5", { lines: 400 })).includes("chunk-300"),
    "the shell never printed",
  );

  const flushes = data.filter((event) => event.terminalId === "terminal-5").length;
  assert.ok(flushes < 300, `300 lines arrived in ${flushes} flushes`);
});

test("a shell that exits keeps what it printed, and closing it takes the terminal away", async (t) => {
  const { updates } = host();
  t.after(() => stopTerminalHost());
  startTerminal("terminal-6", process.cwd());

  writeTerminal("terminal-6", "echo last-word; exit 3\r");

  const exit = await until(
    async () => updates.find((update) => update.terminalId === "terminal-6" && update.status === "exited"),
    "the shell never exited",
  );
  assert.equal(exit.exitCode, 3);

  const snapshot = await readTerminal("terminal-6", { lines: 100 });
  assert.match(lines(snapshot), /last-word/, "an exited shell can still be read");

  closeTerminal("terminal-6");
  assert.equal(await readTerminal("terminal-6", { lines: 100 }), null);
});

test("starting a terminal that already runs keeps the shell it has", async (t) => {
  host();
  t.after(() => stopTerminalHost());
  startTerminal("terminal-7", process.cwd());

  writeTerminal("terminal-7", "echo first-run\r");
  await until(
    async () => lines(await readTerminal("terminal-7", { lines: 100 })).includes("first-run"),
    "the shell never printed",
  );

  startTerminal("terminal-7", process.cwd());

  assert.match(lines(await readTerminal("terminal-7", { lines: 100 })), /first-run/);
});
