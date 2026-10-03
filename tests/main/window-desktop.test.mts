import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import type { WindowDesktopAPI, WindowDesktopCall } from "../../src/contracts/ipc.ts";
import type { WindowDesktopHost } from "../../src/main/window-desktop.ts";

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: { sender: unknown }, ...args: unknown[]) => Promise<unknown>>(),
  invoked: [] as unknown[][],
  exposed: new Map<string, Record<string, unknown>>(),
  reached: [] as unknown[][],
}));

vi.mock("electron", () => ({
  ipcMain: { handle: (name: string, handler: (event: { sender: unknown }, ...args: unknown[]) => Promise<unknown>) => { electron.handlers.set(name, handler); } },
  ipcRenderer: { invoke: async (...args: unknown[]) => { electron.invoked.push(args); }, on() {}, removeListener() {} },
  contextBridge: { exposeInMainWorld: (key: string, api: Record<string, unknown>) => { electron.exposed.set(key, api); } },
  webUtils: { getPathForFile: () => "" },
}));
vi.mock("../../src/main/browser-host.ts", () => ({ setBounds: (bounds: unknown) => { electron.reached.push(["setBrowserBounds", bounds]); } }));
vi.mock("../../src/main/terminal-host.ts", () => ({ terminalSnapshot: async (id: unknown) => { electron.reached.push(["terminalSnapshot", id]); return null; } }));

const { serveWindowDesktop } = await import("../../src/main/window-desktop.ts");
const { useAttachmentsDirectory, writeAttachment } = await import("../../src/main/attachment-store.ts");

type Row<Name extends WindowDesktopCall> = { valid: Parameters<WindowDesktopAPI[Name]>; invalid: unknown[][] };

function record(name: string) {
  return async (...args: unknown[]) => { electron.reached.push([name, ...args]); return null; };
}

const window = { sender: "the window" };
/** The most any call takes. */
const MAX_ARGUMENTS = 5;
const stranger = { sender: "a page in the panel" };

test("every call the window makes is relayed on one channel, refused from anyone else, and refused with bad arguments", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aic-window-desktop-"));
  t.onTestFinished(() => rm(folder, { recursive: true, force: true }));
  useAttachmentsDirectory(folder);
  const saved = await writeAttachment("AQID");
  const dropped = path.join(folder, "dropped.txt");
  await writeFile(dropped, "dropped");
  const host = {
    desktop: { openFolder: record("openFolder"), projectlessWorkspace: record("projectlessWorkspace"), diffPatch: record("diffPatch"), saveAttachment: record("saveAttachment"), focusBrowserTab: record("focusBrowserTab") },
    reads: { read: record("read") },
    setTheme: (theme: unknown) => { electron.reached.push(["setTheme", theme]); },
  } as unknown as WindowDesktopHost;
  serveWindowDesktop(host, (event) => (event.sender as unknown) === window.sender);
  const relay = electron.handlers.get("desktop:call");
  assert.ok(relay);
  assert.deepEqual([...electron.handlers.keys()], ["desktop:call"]);

  const rows: { [Name in WindowDesktopCall]: Row<Name> } = {
    openFolder: { valid: [], invalid: [["extra"]] },
    projectlessWorkspace: { valid: [], invalid: [[1]] },
    commands: { valid: ["workspace", "claude"], invalid: [["", "claude"], ["workspace", "gpt"], [1, "claude"], ["workspace"]] },
    branches: { valid: ["workspace"], invalid: [[""], ["x".repeat(257)], [null], []] },
    diffPatch: {
      valid: ["workspace", { kind: "uncommitted" }, "src/app.ts", "src/old.ts", true],
      invalid: [["workspace", { kind: "nope" }, "src/app.ts"], ["workspace", { kind: "uncommitted" }, ""], ["workspace", { kind: "uncommitted" }, "src/app.ts", 3], ["workspace", { kind: "uncommitted" }, "src/app.ts", undefined, "yes"]],
    },
    describeFiles: { valid: [[dropped]], invalid: [[dropped], [null]] },
    saveAttachment: { valid: ["AQID"], invalid: [[1], ["AQID", 5]] },
    readAttachment: { valid: [saved], invalid: [[5], ["x".repeat(4_097)]] },
    readAttachmentContext: { valid: [saved], invalid: [[{}]] },
    setBrowserBounds: { valid: [{ x: 1, y: 2, width: 300, height: 400 }], invalid: [[{ x: "1", y: 2, width: 300, height: 400 }], [undefined]] },
    focusBrowserTab: { valid: ["tab"], invalid: [[""], [7]] },
    terminalSnapshot: { valid: ["terminal"], invalid: [[42]] },
    readRemoteTerminal: { valid: ["holder", "terminal", 3], invalid: [["holder", "terminal", -1], ["holder", "terminal", 1.5], ["", "terminal"]] },
    setTheme: { valid: [{ variant: "dark", canvas: "#0e1117" }], invalid: [[{ variant: "blue", canvas: "#0e1117" }], [{ variant: "dark", canvas: "red" }]] },
  };
  /** Answered in main itself rather than handed on, so what comes back is what shows the call got through. */
  const answered: Partial<Record<WindowDesktopCall, unknown>> = {
    describeFiles: [{ path: dropped, name: "dropped.txt" }],
    readAttachment: "AQID",
    readAttachmentContext: null,
  };

  for (const [name, row] of Object.entries(rows) as Array<[WindowDesktopCall, Row<WindowDesktopCall>]>) {
    const before = electron.reached.length;
    const result = await relay(window, name, ...row.valid);
    if (name in answered) assert.deepEqual(result, answered[name], name);
    else assert.equal(electron.reached.length, before + 1, `${name} reaches what answers it`);

    const reached = electron.reached.length;
    await assert.rejects(relay(stranger, name, ...row.valid), /Untrusted IPC sender/, name);
    const overlong = [...row.valid, ...Array<undefined>(MAX_ARGUMENTS - row.valid.length).fill(undefined), "one too many"];
    await assert.rejects(relay(window, name, ...overlong), new RegExp(`Invalid ${name} call`), name);
    for (const args of row.invalid) await assert.rejects(relay(window, name, ...args), new RegExp(`Invalid ${name} call`), `${name} ${JSON.stringify(args)}`);
    assert.equal(electron.reached.length, reached, `nothing refused reaches ${name}`);
  }
  assert.deepEqual(electron.reached.find((entry) => entry[0] === "read" && (entry[1] as { kind: string }).kind === "terminal-output"), ["read", { kind: "terminal-output", terminalId: "terminal", after: 3 }, { computer: "holder" }]);
  for (const name of ["constructor", "__proto__", "hasOwnProperty", "send", 42]) await assert.rejects(relay(window, name), /Unknown desktop call/, String(name));
  await assert.rejects(relay(stranger, "send"), /Untrusted IPC sender/);

  await import("../../src/preload.ts");
  const desktop = electron.exposed.get("desktop");
  assert.ok(desktop);
  assert.ok(electron.exposed.has("workspace"));
  const relayed = Object.keys(desktop).filter((key) => key !== "platform" && key !== "pathForFile" && !/^on[A-Z]/.test(key));
  assert.deepEqual(relayed.sort(), Object.keys(rows).sort(), "the preload relays exactly the calls main answers");
  for (const [name, row] of Object.entries(rows)) {
    await (desktop[name] as (...args: unknown[]) => Promise<unknown>)(...row.valid);
    assert.deepEqual(electron.invoked.at(-1), ["desktop:call", name, ...row.valid]);
  }
});
