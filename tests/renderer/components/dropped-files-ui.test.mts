import assert from "node:assert/strict";
import { test, afterAll } from "vitest";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { TaskComposerProps } from "../../../src/renderer/components/TaskComposer.tsx";
import type { AttachedFile } from "../../../src/domain/task.ts";
import type { DesktopAPI } from "../../../src/contracts/ipc.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
for (const name of ["window", "document", "Element", "Node", "HTMLElement", "Event", "KeyboardEvent", "navigator"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
/** React watches the focused field through the event methods only IE ever had, which jsdom has not. */
Object.defineProperties(dom.window.HTMLTextAreaElement.prototype, { attachEvent: { value() {} }, detachEvent: { value() {} } });
Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", { value() {} });
Object.defineProperty(window, "desktop", { value: {
  commands: async () => ({ status: "error", message: "unavailable" } as const),
  projectlessWorkspace: async () => ({ id: "workspace-1", kind: "projectless", root: "/project" } as const),
} satisfies Pick<DesktopAPI, "commands" | "projectlessWorkspace"> });

const { TaskComposer } = await import("../../../src/renderer/components/TaskComposer.tsx");
const { useFileDrop } = await import("../../../src/renderer/file-drop.ts");

afterAll(async () => {
  dom.window.close();
});

async function mount(element: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return {
    container,
    async render(next: React.ReactNode) { await act(async () => { root.render(next); }); },
    async unmount() { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

function query<E extends Element = HTMLElement>(root: ParentNode, selector: string): E {
  const element = root.querySelector<E>(selector);
  assert.ok(element, `Missing ${selector}`);
  return element;
}

function composer(props: Partial<TaskComposerProps>) {
  return React.createElement(TaskComposer, {
    prompt: "",
    folder: "/project",
    workspaceId: "workspace-1",
    mode: "confirm",
    model: "opus",
    effort: "medium",
    runActive: false,
    queuedMessages: [],
    onPromptChange() {},
    onModeChange() {},
    onModelChange() {},
    onEffortChange() {},
    onSend() {},
    onSteerQueued() {},
    onDropQueued() {},
    onCancel() {},
    ...props,
  });
}

const files: AttachedFile[] = [
  { id: "f1", path: "/Users/me/report.pdf", name: "report.pdf" },
  { id: "f2", path: "/Users/me/shots", name: "shots", folder: true },
];

/** A drag carrying what the desktop hands over, which jsdom does not build itself. */
function dragEvent(kind: string, types: string[], dropped: File[] = []) {
  const event = new dom.window.Event(kind, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { types, files: dropped, dropEffect: "none" } });
  return event;
}

test("attached files wear their names, and a folder says it is one", async () => {
  const view = await mount(composer({ files, onFileRemove() {} }));
  const pills = [...view.container.querySelectorAll(".file-pill")];

  assert.deepEqual(pills.map((pill) => query(pill, ".file-name strong").textContent), ["report.pdf", "shots"]);
  assert.equal(query(pills[1], ".file-name small").textContent, "Folder");
  assert.equal(query(pills[0], ".file-name").getAttribute("title"), "/Users/me/report.pdf");
  assert.equal(pills[0].tagName === "SPAN" && query(pills[0], "button.file-name").tagName, "BUTTON", "a file opens; a folder does not");
  assert.equal(pills[1].querySelector("button.file-name"), null);
  await view.unmount();
});

test("a file can be taken off the draft, and a sent one cannot", async () => {
  const removed: string[] = [];
  const view = await mount(composer({ files, onFileRemove: (fileId) => { removed.push(fileId); } }));
  await act(async () => { query<HTMLButtonElement>(view.container, ".file-remove").click(); });
  assert.deepEqual(removed, ["f1"]);

  await view.render(composer({ files }));
  assert.equal(view.container.querySelector(".file-row"), null, "a composer that cannot remove shows no row of its own");
  await view.unmount();
});

test("a drop alone is enough to send", async () => {
  const view = await mount(composer({ files, onFileRemove() {} }));
  assert.equal(query<HTMLButtonElement>(view.container, ".send-button").disabled, false);

  await view.render(composer({ onFileRemove() {} }));
  assert.equal(query<HTMLButtonElement>(view.container, ".send-button").disabled, true);
  await view.unmount();
});

test("a send that carried only files is offered back on the up arrow", async () => {
  const recalled: AttachedFile[][] = [];
  function Harness() {
    const [prompt, setPrompt] = React.useState("");
    return composer({
      prompt,
      history: [{ text: "", annotations: [], pastes: [], files, attachments: [] }],
      onPromptChange: setPrompt,
      onFileRecall: (put) => { recalled.push(put); },
      onFileRemove() {},
    });
  }
  const view = await mount(React.createElement(Harness));
  const field = query<HTMLTextAreaElement>(view.container, 'textarea[aria-label="Task prompt"]');
  await act(async () => { field.focus(); });
  await act(async () => { field.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" })); });

  assert.deepEqual(recalled, [files], "the files come back with the message they rode with");
  await view.unmount();
});

test("a sent image is offered back on the up arrow, with the message it rode with", async () => {
  const recalled: string[][] = [];
  function Harness() {
    const [prompt, setPrompt] = React.useState("");
    return composer({
      prompt,
      history: [{ text: "look at this", annotations: [], pastes: [], files: [], attachments: ["/attachments/one.png"] }],
      onPromptChange: setPrompt,
      onImageRecall: (paths) => { recalled.push(paths); },
      onFileRemove() {},
    });
  }
  const view = await mount(React.createElement(Harness));
  const field = query<HTMLTextAreaElement>(view.container, 'textarea[aria-label="Task prompt"]');
  await act(async () => { field.focus(); });
  await act(async () => { field.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" })); });

  assert.deepEqual(recalled, [["/attachments/one.png"]]);
  await view.unmount();
});

test("a surface takes files dragged in, and lets everything else pass", async () => {
  const drops: string[][] = [];
  function Surface() {
    const drop = useFileDrop((dropped) => { drops.push(dropped.map((file) => file.name)); });
    return React.createElement("div", { className: `surface ${drop.over ? "dropping" : ""}`, ...drop.props });
  }
  const view = await mount(React.createElement(Surface));
  const surface = query(view.container, ".surface");

  await act(async () => { surface.dispatchEvent(dragEvent("dragenter", ["Files"])); });
  assert.match(surface.className, /dropping/, "the surface says a drop would land here");

  const dropped = new dom.window.File(["x"], "report.pdf");
  await act(async () => { surface.dispatchEvent(dragEvent("drop", ["Files"], [dropped])); });
  assert.deepEqual(drops, [["report.pdf"]]);
  assert.doesNotMatch(surface.className, /dropping/, "the surface settles once the drop lands");

  await act(async () => { surface.dispatchEvent(dragEvent("dragenter", ["text/plain"])); });
  assert.doesNotMatch(surface.className, /dropping/, "a thread being dragged in the sidebar is not a file");
  await view.unmount();
});
