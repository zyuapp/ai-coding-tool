import { fakeDesktop } from "../support/desktop-api.mts";
import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";

import { settleUntil } from "../support/settle.mts";
import { outbox, useSavingOutbox } from "../support/composer-outbox.mts";

import { MAX_ATTACHMENTS, type PastedText, type RunAttachment } from "../../src/domain/conversation.ts";

import type { ConversationComposerProps } from "../../src/renderer/components/ConversationComposer.tsx";

import { dom, item, mount, query } from "../support/renderer-dom.mts";
import type { AppCommand } from "../../src/contracts/commands.ts";
import { CommandControlsProvider } from "../../src/renderer/components/CommandControl.tsx";

const { ConversationComposer } = await import("../../src/renderer/components/ConversationComposer.tsx");

function renderConversationComposer(overrides: Partial<ConversationComposerProps>) {
  return React.createElement(ConversationComposer, {
    prompt: "",
    folder: "",
    mode: "confirm",
    engine: "claude", engineLabel: "Claude",
    model: "opus",
    effort: "high",
    runActive: false,
    queuedMessages: [],
    onPromptChange() {},
    onModeChange() {},
    onModelChange() {},
    onEffortChange() {}, fastMode: false, onFastModeChange() {},
    outbox: outbox(),
    onSteerQueued() {},
    onEditQueued() {}, onDropQueued() {},
    onCancel() {}, onFilesAdd() {},
    ...overrides,
  });
}

test("an active native goal stays visible and can be cleared", async () => {
  let cleared = 0;
  const view = await mount(renderConversationComposer({
    goal: { objective: "All checks pass", status: "active", iterations: 2 },
    onGoalClear: () => { cleared += 1; },
  }));

  assert.match(query(view.container, ".goal-bar").textContent, /All checks pass/);
  assert.match(query(view.container, ".goal-detail").textContent, /Pass 2/);
  await act(async () => { query<HTMLButtonElement>(view.container, ".goal-clear").click(); });
  assert.equal(cleared, 1);
  await view.unmount();
});

test("context usage stays within 100% when the window shrinks below the used tokens", async () => {
  window.desktop = fakeDesktop();
  const view = await mount(renderConversationComposer({
    prompt: "",
    folder: "/project",
    workspaceId: "workspace-1",
    mode: "confirm",
    engine: "claude", engineLabel: "Claude",
    model: "opus",
    contextUsage: { tokens: 620_000, limit: 200_000, model: "claude-opus-5" },
    runActive: false,
    onPromptChange() {},
    onModeChange() {},
    onModelChange() {},
    queuedMessages: [],
    onSteerQueued() {},
    onEditQueued() {}, onDropQueued() {},
    outbox: outbox(),
    onCancel() {},
  }));
  await act(async () => {});

  const usage = query(view.container, ".context-usage");
  assert.equal(usage.getAttribute("aria-label"), "100% of context window used");
  assert.match(usage.textContent, /100% used0% left/);
  assert.match(usage.textContent, /620K \/ 200K tokens used/);
  await view.unmount();
});

test("one outside pointer press dismisses the slash menu until the draft changes", async () => {
  window.desktop = fakeDesktop({ commands: async () => ({ status: "available", commands: [{ name: "review", description: "Review this change.", argumentHint: "" }] }) });
  function Harness() {
    const [prompt, setPrompt] = React.useState("");
    return renderConversationComposer({
      prompt, folder: "/project", workspaceId: "workspace-1", mode: "confirm", engine: "claude", engineLabel: "Claude", model: "opus", effort: "medium", runActive: false,
      onPromptChange: setPrompt, onModeChange() {}, onModelChange() {}, onEffortChange() {}, fastMode: false, onFastModeChange() {}, queuedMessages: [], onSteerQueued() {}, onEditQueued() {}, onDropQueued() {}, outbox: outbox(), onCancel() {},
    });
  }
  const view = await mount(React.createElement(Harness));
  const textarea = query<HTMLTextAreaElement>(view.container, "textarea");
  const setValue = item(Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")).set;
  await act(async () => {
    textarea.focus();
    item(setValue).call(textarea, "/");
    textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
  assert.ok(view.container.querySelector(".command-menu"));
  await act(async () => { document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
  assert.equal(view.container.querySelector(".command-menu"), null);
  await act(async () => {
    item(setValue).call(textarea, "/r");
    textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
  assert.ok(view.container.querySelector(".command-menu"), "typing again reopens matching commands");
  await view.unmount();
});

test("a slash action runs at once and clears the draft", async () => {
  window.desktop = fakeDesktop({
    commands: async () => ({ status: "available", commands: [
      { name: "security-scan", description: "Scan the repository for security issues. Extra details are hidden.", argumentHint: "" },
      { name: "pdf", description: "Work with PDF files.", argumentHint: "<file>" },
    ] }),
  });
  let sends = 0;
  let opened = 0;
  function Harness() {
    const [prompt, setPrompt] = React.useState("");
    return renderConversationComposer({
      prompt,
      folder: "/project",
      workspaceId: "workspace-1",
      mode: "confirm",
      engine: "claude", engineLabel: "Claude",
      model: "opus",
      runActive: false,
      actions: [{ name: "side", description: "Open a focused side chat.", run: () => { opened += 1; } }],
      onPromptChange: setPrompt,
      onModeChange() {},
      onModelChange() {},
      queuedMessages: [],
      onSteerQueued() {},
      onEditQueued() {}, onDropQueued() {},
      outbox: outbox({ send: () => { sends += 1; } }),
      onCancel() {},
    });
  }
  const view = await mount(React.createElement(Harness));
  const textarea = query<HTMLTextAreaElement>(view.container, 'textarea[aria-label="Task prompt"]');
  const setValue = item(Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")).set;
  const scrolled: Array<{ id: string; options?: boolean | ScrollIntoViewOptions }> = [];
  const originalScrollIntoView = dom.window.HTMLElement.prototype.scrollIntoView;
  dom.window.HTMLElement.prototype.scrollIntoView = function (options) { scrolled.push({ id: this.id, options }); };

  await act(async () => {
    textarea.focus();
    item(setValue).call(textarea, "/s");
    textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "/s" }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  });
  assert.deepEqual([...view.container.querySelectorAll('[role="option"] strong')].map((node) => node.textContent), ["/side", "/security-scan"]);
  const [side, scan] = [...view.container.querySelectorAll<HTMLElement>('[role="option"]')];
  assert.equal(scan?.dataset.tip, "Scan the repository for security issues. Extra details are hidden.", "a description cut short keeps its whole text on hover");
  assert.equal(side?.dataset.tip, undefined, "one shown whole needs no tip");

  await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })); });
  assert.deepEqual(scrolled.at(-1), { id: "slash-command-1", options: { block: "nearest" } });
  await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" })); });

  await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })); });
  assert.equal(opened, 1, "choosing an action performs it");
  assert.equal(textarea.value, "", "the action takes its own name out of the draft");
  assert.equal(view.container.querySelector(".command-menu"), null);
  await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })); });
  assert.equal(sends, 0, "an emptied draft has nothing to send");
  dom.window.HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  await view.unmount();
});

test("the up arrow recalls sent prompts and the down arrow walks back to the draft", async () => {
  window.desktop = fakeDesktop();
  function Harness() {
    const [prompt, setPrompt] = React.useState("");
    return renderConversationComposer({
      prompt,
      folder: "/project",
      workspaceId: "workspace-1",
      mode: "confirm",
      engine: "claude", engineLabel: "Claude",
      model: "opus",
      runActive: false,
      history: ["first question", "first question", "second\nquestion"].map((text) => ({ text, annotations: [], pastes: [], files: [], attachments: [] })),
      onPromptChange: setPrompt,
      onModeChange() {},
      onModelChange() {},
      queuedMessages: [],
      onSteerQueued() {},
      onEditQueued() {}, onDropQueued() {},
      outbox: outbox(),
      onCancel() {},
    });
  }
  const view = await mount(React.createElement(Harness));
  const textarea = query<HTMLTextAreaElement>(view.container, 'textarea[aria-label="Task prompt"]');
  const setValue = item(Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")).set;
  const press = (key: string) => act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key })); });
  const type = (text: string) => act(async () => {
    item(setValue).call(textarea, text);
    textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  });

  const upIs = async (expected: string, why: string) => { await press("ArrowUp"); assert.equal(textarea.value, expected, why); };
  const downIs = async (expected: string, why: string) => { await press("ArrowDown"); assert.equal(textarea.value, expected, why); };

  await act(async () => { textarea.focus(); });
  await type("a draft");
  await upIs("a draft", "up in a typed draft moves the caret, not the history");
  await type("");
  await upIs("second\nquestion", "up in an empty composer recalls the newest sent prompt");
  await upIs("second\nquestion", "up below the first line of a recalled prompt moves the caret");
  await act(async () => { textarea.setSelectionRange(0, 0); });
  await upIs("first question", "up from the first line walks back, skipping the repeated send");
  await upIs("first question", "the oldest entry is the end of the line");
  await downIs("second\nquestion", "down walks forward again");
  await downIs("", "down past the newest restores the stashed empty draft");
  await downIs("", "with no recall going, down is just a caret move");
  await press("ArrowUp");
  await type("second question edited");
  await upIs("second question edited", "editing a recalled prompt ends the recall");
  await view.unmount();
});

test("a skill completes anywhere in the draft, where an action is not offered", async () => {
  window.desktop = fakeDesktop({
    commands: async () => ({ status: "available", commands: [
      { name: "security-scan", description: "Scan the repository for security issues.", argumentHint: "" },
    ] }),
  });
  function Harness() {
    const [prompt, setPrompt] = React.useState("");
    return renderConversationComposer({
      prompt,
      folder: "/project",
      workspaceId: "workspace-1",
      mode: "confirm",
      engine: "claude", engineLabel: "Claude",
      model: "opus",
      runActive: false,
      actions: [{ name: "side", description: "Open a focused side chat.", run() {} }],
      onPromptChange: setPrompt,
      onModeChange() {},
      onModelChange() {},
      queuedMessages: [],
      onSteerQueued() {},
      onEditQueued() {}, onDropQueued() {},
      outbox: outbox(),
      onCancel() {},
    });
  }
  const view = await mount(React.createElement(Harness));
  const textarea = query<HTMLTextAreaElement>(view.container, 'textarea[aria-label="Task prompt"]');
  const setValue = item(Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")).set;
  const type = async (value: string, inputType = "insertText") => {
    await act(async () => {
      textarea.focus();
      item(setValue).call(textarea, value);
      textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType }));
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };

  await type("look at this /s");
  assert.deepEqual([...view.container.querySelectorAll('[role="option"] strong')].map((node) => node.textContent), ["/security-scan"], "a half-written draft offers skills alone");

  await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })); });
  assert.equal(textarea.value, "look at this /security-scan", "the completion replaces the token it grew from");

  await type("src/s");
  assert.equal(view.container.querySelector(".command-menu"), null, "a path is not a command");

  await type("/s", "insertFromPaste");
  assert.equal(view.container.querySelector(".command-menu"), null, "pasted text is not typing");
  await view.unmount();
});

test("the @ menu offers threads, keeps browsing in this project, and completes to a handle", async () => {
  const threads = [
    { id: "t-1", title: "Raise the dock", handle: "raise-the-dock", project: "app", inScope: true, running: false, lastActivityAt: 3 },
    { id: "t-2", title: "Raise the panel", handle: "site/raise-the-panel", project: "site", inScope: false, running: false, lastActivityAt: 2 },
  ];
  function Harness() {
    const [prompt, setPrompt] = React.useState("");
    return renderConversationComposer({
      prompt,
      folder: "/project",
      workspaceId: "workspace-1",
      mode: "confirm",
      engine: "claude", engineLabel: "Claude",
      model: "opus",
      runActive: false,
      threads,
      onPromptChange: setPrompt,
      onModeChange() {},
      onModelChange() {},
      queuedMessages: [],
      onSteerQueued() {},
      onEditQueued() {}, onDropQueued() {},
      outbox: outbox(),
      onCancel() {},
    });
  }
  const view = await mount(React.createElement(Harness));
  const textarea = query<HTMLTextAreaElement>(view.container, 'textarea[aria-label="Task prompt"]');
  const setValue = item(Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")).set;
  const type = async (value: string) => {
    await act(async () => {
      textarea.focus();
      item(setValue).call(textarea, value);
      textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText" }));
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };
  const offered = () => [...view.container.querySelectorAll('.thread-menu [role="option"] strong')].map((node) => node.textContent);

  await type("compare with @");
  assert.deepEqual(offered(), ["Raise the dock"], "browsing stays in this project");

  await type("compare with @raise");
  assert.deepEqual(offered(), ["Raise the dock", "Raise the panel"], "a query reaches the other projects");

  await type("compare with @panel");
  assert.deepEqual(offered(), ["Raise the panel"]);

  await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })); });
  assert.equal(textarea.value, "compare with @site/raise-the-panel ");
  assert.equal(view.container.querySelector(".thread-menu"), null, "the menu closes once a thread is chosen");

  await type("mail me at zhuocheng@gmail");
  assert.equal(view.container.querySelector(".thread-menu"), null, "an address is not a mention");

  await type("compare with @nothing-like-this");
  assert.deepEqual(offered(), []);
  assert.equal(query(view.container, ".thread-menu .command-empty").textContent, "No thread matches", "a typo says so rather than closing the menu");
  const arrow = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowUp" });
  await act(async () => { textarea.dispatchEvent(arrow); });
  assert.equal(arrow.defaultPrevented, false, "an empty menu leaves the arrows to the caret");
  await view.unmount();
});

test("the side surface keeps the slash palette but never offers to fork a fork", async () => {
  window.desktop = fakeDesktop({
    commands: async () => ({ status: "available", commands: [
      { name: "security-scan", description: "Scan the repository for security issues.", argumentHint: "" },
    ] }),
  });
  function Harness() {
    const [prompt, setPrompt] = React.useState("");
    return renderConversationComposer({
      prompt,
      folder: "/project",
      workspaceId: "workspace-1",
      surface: "side",
      mode: "confirm",
      engine: "claude", engineLabel: "Claude",
      model: "opus",
      runActive: false,
      onPromptChange: setPrompt,
      onModeChange() {},
      onModelChange() {},
      queuedMessages: [],
      onSteerQueued() {},
      onEditQueued() {}, onDropQueued() {},
      outbox: outbox(),
      onCancel() {},
    });
  }
  const view = await mount(React.createElement(Harness));
  const textarea = query<HTMLTextAreaElement>(view.container, 'textarea[aria-label="Side chat prompt"]');
  const setValue = item(Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")).set;
  await act(async () => {
    textarea.focus();
    item(setValue).call(textarea, "/s");
    textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "/s" }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  });

  assert.deepEqual([...view.container.querySelectorAll('[role="option"] strong')].map((node) => node.textContent), ["/security-scan"]);
  assert.equal(query<HTMLButtonElement>(view.container, 'button[aria-label="Send side chat message"]').disabled, false);
  await view.unmount();
});

test("a pasted image becomes an attachment chip and is saved on send", async () => {
  window.desktop = fakeDesktop();
  let sent: RunAttachment[] | null = null;
  function Harness() {
    const [prompt, setPrompt] = React.useState("");
    const sending = useSavingOutbox((attachments) => { sent = attachments; });
    return renderConversationComposer({
      prompt,
      folder: "/project",
      workspaceId: "workspace-1",
      mode: "confirm",
      engine: "claude", engineLabel: "Claude",
      model: "opus",
      runActive: false,
      onPromptChange: setPrompt,
      onModeChange() {},
      onModelChange() {},
      queuedMessages: [],
      onSteerQueued() {},
      onEditQueued() {}, onDropQueued() {},
      outbox: sending,
      onCancel() {},
    });
  }
  const view = await mount(React.createElement(Harness));
  const send = query<HTMLButtonElement>(view.container, 'button[aria-label="Send task"]');
  assert.equal(send.disabled, true);

  const paste = new dom.window.Event("paste", { bubbles: true });
  Object.defineProperty(paste, "clipboardData", { value: { files: [new dom.window.File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" })] } });
  await act(async () => { query<HTMLTextAreaElement>(view.container, "textarea").dispatchEvent(paste); });
  /** Reading the file and saving it is a chain of promises, so this waits for the chip, not a tick. */
  await settleUntil(() => view.container.querySelectorAll(".attachment-chip").length === 1);
  assert.equal(query<HTMLButtonElement>(view.container, 'button[aria-label="Send task"]').disabled, false);

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Send task"]').click(); });
  await settleUntil(() => view.container.querySelectorAll(".attachment-chip").length === 0);
  assert.deepEqual(sent, [{ path: "/tmp/aicodingtool-attachments/pasted.png", labels: [] }]);
  await view.unmount();
});

test("a long paste is held aside as a pill, and a short one lands in the draft", async () => {
  window.desktop = fakeDesktop();
  const added: string[] = [];
  const removed: string[] = [];
  const blob = Array.from({ length: 40 }, (_, line) => `line ${line}`).join("\n");
  function Harness({ pastes }: { pastes: PastedText[] }) {
    const [prompt, setPrompt] = React.useState("");
    return renderConversationComposer({
      prompt,
      folder: "/project",
      workspaceId: "workspace-1",
      mode: "confirm",
      engine: "claude", engineLabel: "Claude",
      model: "opus",
      runActive: false,
      pastes,
      onPromptChange: setPrompt,
      onPasteAdd: (text) => { added.push(text); },
      onPasteRemove: (pasteId) => { removed.push(pasteId); },
      onModeChange() {},
      onModelChange() {},
      queuedMessages: [],
      onSteerQueued() {},
      onEditQueued() {}, onDropQueued() {},
      outbox: outbox(),
      onCancel() {},
    });
  }
  const view = await mount(React.createElement(Harness, { pastes: [] }));
  const textarea = query<HTMLTextAreaElement>(view.container, "textarea");

  function pasteText(text: string) {
    const event = new dom.window.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { files: [], getData: () => text } });
    return event;
  }

  const short = pasteText("a line I meant to type");
  await act(async () => { textarea.dispatchEvent(short); });
  assert.deepEqual(added, [], "a short paste is the textarea's own business");
  assert.equal(short.defaultPrevented, false);

  const long = pasteText(blob);
  await act(async () => { textarea.dispatchEvent(long); });
  assert.deepEqual(added, [blob]);
  assert.equal(long.defaultPrevented, true, "the blob never reaches the draft");

  await view.render(React.createElement(Harness, { pastes: [{ id: "paste-1", text: blob }] }));
  const pill = query(view.container, ".paste-pill");
  assert.match(pill.textContent, /Pasted text #1/);
  assert.match(pill.textContent, /40 lines/);
  assert.equal(query<HTMLButtonElement>(view.container, 'button[aria-label="Send task"]').disabled, false, "a paste alone is enough to send");

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Read pasted text 1"]').click(); });
  assert.match(query(document.body, ".paste-full").textContent, /line 39/);
  await act(async () => { query<HTMLButtonElement>(document.body, ".viewer-close").click(); });
  assert.equal(document.body.querySelector(".paste-full"), null);

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Remove pasted text 1"]').click(); });
  assert.deepEqual(removed, ["paste-1"]);
  await view.unmount();
});

test("the send button holds while the checkout a send needs is still being made", async () => {
  window.desktop = fakeDesktop();
  const sent: string[] = [];
  const composer = (waiting: boolean) => React.createElement(ConversationComposer, {
    prompt: "Refactor the loader", folder: "/project", workspaceId: "workspace-1", mode: "confirm", engine: "claude", engineLabel: "Claude", model: "opus", effort: "medium",
    runActive: false, waiting, queuedMessages: [],
    onPromptChange() {}, onModeChange() {}, onModelChange() {}, onEffortChange() {}, fastMode: false, onFastModeChange() {}, onSteerQueued() {}, onEditQueued() {}, onDropQueued() {},
    outbox: outbox({ send: () => { sent.push("sent"); } }), onCancel() {}, onFilesAdd() {},
  });

  const view = await mount(composer(true));
  const send = query<HTMLButtonElement>(view.container, ".send-button");
  assert.equal(send.disabled, true, "a second Enter is refused visibly rather than swallowed");
  assert.equal(send.getAttribute("aria-busy"), "true", "the held send reads as on its way, not as nothing to send");
  assert.ok(send.querySelector(".send-spinner"));
  await act(async () => { send.click(); });
  assert.deepEqual(sent, []);

  await view.render(composer(false));
  assert.equal(query(view.container, ".send-button").getAttribute("aria-busy"), null);
  assert.equal(view.container.querySelector(".send-button .send-spinner"), null);
  await act(async () => { query<HTMLButtonElement>(view.container, ".send-button").click(); });
  assert.deepEqual(sent, ["sent"], "the button works again once the checkout has landed");
  await view.unmount();
});

test("only the user's own queued words offer to be edited", async () => {
  const own = { id: "own", text: "Also fix the tests", prompt: "Also fix the tests", attachments: [] };
  const answer = { id: "answer", text: "The user decided \"Which DB?\": SQLite", prompt: "The user decided \"Which DB?\": SQLite", attachments: [], answers: "d1" };
  const sent = { id: "sent", text: "Rebase first", prompt: "Rebase first", attachments: [], origin: { kind: "thread" as const, threadId: "lead", title: "Lead" }, detail: "From Lead · lead" };
  const view = await mount(renderConversationComposer({ runActive: true, queuedMessages: [own, answer, sent] }));
  const editable = [...view.container.querySelectorAll(".queued-message")].map((row) => Boolean(row.querySelector(".queued-edit")));
  assert.deepEqual(editable, [true, false, false], "a decision's answer and another thread's message are not the user's to edit");
  await view.unmount();
});

test("the attach button hands picked files to the surface, the way a drop would", async () => {
  window.desktop = fakeDesktop();
  const added: string[][] = [];
  const view = await mount(renderConversationComposer({ onFilesAdd: (files) => { added.push(files.map((file) => file.name)); } }));
  const input = query<HTMLInputElement>(view.container, 'input[type="file"]');
  let opened = 0;
  input.click = () => { opened += 1; };
  await act(async () => { query<HTMLButtonElement>(view.container, ".composer-attach").click(); });
  assert.equal(opened, 1, "the button opens the system picker");

  const picked = [new dom.window.File(["a"], "notes.txt", { type: "text/plain" }), new dom.window.File(["b"], "shot.png", { type: "image/png" })];
  Object.defineProperty(input, "files", { configurable: true, value: picked });
  await act(async () => { input.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  assert.deepEqual(added, [["notes.txt", "shot.png"]]);
  await view.unmount();

  const disabled = await mount(renderConversationComposer({ disabled: true }));
  assert.equal(query<HTMLButtonElement>(disabled.container, ".composer-attach").disabled, true);
  await disabled.unmount();
});

test("while a run goes, a written message shows how to queue it or steer it in", async () => {
  window.desktop = fakeDesktop();
  const idle = await mount(renderConversationComposer({ prompt: "check the logs" }));
  assert.equal(idle.container.querySelector(".composer-hint"), null, "with no run going Enter just sends");
  await idle.unmount();

  const empty = await mount(renderConversationComposer({ runActive: true }));
  assert.equal(empty.container.querySelector(".composer-hint"), null, "nothing written, nothing to steer");
  await empty.unmount();

  const running = await mount(renderConversationComposer({ prompt: "check the logs", runActive: true }));
  const hint = query(running.container, ".composer-hint");
  assert.match(hint.textContent ?? "", /queue.*steer/);
  assert.equal(query(running.container, "textarea").getAttribute("aria-describedby"), hint.id, "the prompt names the keys to a screen reader too");
  assert.ok(query(hint, ".composer-hint-queue"), "the queue half is the part a narrow composer lets go, keeping steer");
  assert.equal(query(running.container, ".send-button").dataset.tip, "Stop", "the hint is not repeated on Stop");
  await running.unmount();
});

test("a send notice can be put away", async () => {
  window.desktop = fakeDesktop();
  const notices: (string | null)[] = [];
  const view = await mount(renderConversationComposer({
    outbox: outbox({ state: { ...outbox().state, error: "Wait for the screenshots to finish loading." }, notice: (message) => { notices.push(message); } }),
  }));
  const notice = query(view.container, ".attachment-error");
  assert.match(notice.textContent ?? "", /Wait for the screenshots/);
  assert.equal(notice.getAttribute("role"), "alert");
  assert.ok(!notice.classList.contains("note"));
  await act(async () => { query<HTMLButtonElement>(view.container, '.attachment-error button[aria-label="Dismiss"]').click(); });
  assert.deepEqual(notices, [null]);
  await view.unmount();
});

test("an image limit reads as a note, not a failure, and can be put away", async () => {
  window.desktop = fakeDesktop();
  const view = await mount(renderConversationComposer({ outbox: outbox() }));
  const textarea = query<HTMLTextAreaElement>(view.container, "textarea");
  const files = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, index) => new dom.window.File([new Uint8Array([1, 2, 3])], `shot-${index}.png`, { type: "image/png" }));
  const paste = new dom.window.Event("paste", { bubbles: true });
  Object.defineProperty(paste, "clipboardData", { value: { files } });
  await act(async () => { textarea.dispatchEvent(paste); });
  await settleUntil(() => view.container.querySelector(".attachment-error") !== null);
  const notice = query(view.container, ".attachment-error");
  assert.ok(notice.classList.contains("note"));
  assert.equal(notice.getAttribute("role"), "status");
  assert.equal(notice.textContent, `Only the first ${MAX_ATTACHMENTS} images were attached.`);
  await act(async () => { query<HTMLButtonElement>(notice, 'button[aria-label="Dismiss"]').click(); });
  assert.equal(view.container.querySelector(".attachment-error"), null);
  await view.unmount();
});

test("a thread this build cannot open offers the update that opens it", async () => {
  window.desktop = fakeDesktop();
  const dispatched: AppCommand[] = [];
  const view = await mount(React.createElement(CommandControlsProvider, { value: { available: () => true, dispatch: (command) => { dispatched.push(command); } } },
    renderConversationComposer({ unopenable: "Runs on gemini, which this version can't open. Update to work in it here." })));
  assert.equal(view.container.querySelector("textarea"), null);
  await act(async () => { query<HTMLButtonElement>(view.container, ".composer-unopenable-update").click(); });
  assert.deepEqual(dispatched, [{ type: "app.update" }]);
  await view.unmount();
});

test("the context ring says how full it is, and compacts once compaction is near", async () => {
  window.desktop = fakeDesktop();
  let compacted = 0;
  const onCompact = () => { compacted += 1; };
  const low = await mount(renderConversationComposer({ contextUsage: { tokens: 40_000, limit: 200_000, model: "claude-opus-5" }, onCompact }));
  assert.equal(query(low.container, ".context-usage-value").textContent, "20%");
  assert.equal(query(low.container, ".context-usage").tagName, "SPAN", "far from compaction it stays a readout");
  await low.unmount();

  const high = await mount(renderConversationComposer({ contextUsage: { tokens: 180_000, limit: 200_000, model: "claude-opus-5" }, onCompact }));
  const meter = query<HTMLButtonElement>(high.container, ".context-usage");
  assert.equal(meter.tagName, "BUTTON");
  assert.equal(query(meter, ".context-usage-value").textContent, "90%");
  await act(async () => { meter.click(); });
  assert.equal(compacted, 1);
  await high.unmount();

  const unoffered = await mount(renderConversationComposer({ contextUsage: { tokens: 180_000, limit: 200_000, model: "claude-opus-5" } }));
  assert.equal(query(unoffered.container, ".context-usage").tagName, "SPAN", "where compacting is not on offer the ring only reads");
  await unoffered.unmount();
});

test("a queued message cut short opens out in place, and one that fits stays still", async () => {
  window.desktop = fakeDesktop();
  const width = Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, "scrollWidth");
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollWidth", { configurable: true, get(this: HTMLElement) { return this.textContent?.startsWith("Long") ? 900 : 0; } });
  try {
    const view = await mount(renderConversationComposer({ runActive: true, queuedMessages: [
      { id: "long", text: "Long message that runs well past the row", prompt: "Long", attachments: [] },
      { id: "short", text: "Short", prompt: "Short", attachments: [] },
    ] }));
    const [long, short] = [...view.container.querySelectorAll<HTMLElement>(".queued-text")];
    assert.equal(short.getAttribute("role"), null, "text that fits is not a control");
    assert.equal(long.getAttribute("aria-expanded"), "false");
    await act(async () => { long.click(); });
    assert.equal(long.getAttribute("aria-expanded"), "true");
    assert.ok(long.classList.contains("open"));
    await act(async () => { long.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    assert.equal(long.getAttribute("aria-expanded"), "false", "Enter folds it back");
    await view.unmount();
  } finally {
    if (width) Object.defineProperty(dom.window.HTMLElement.prototype, "scrollWidth", width);
    else delete (dom.window.HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
  }
});

test("Enter in the base branch search reviews the top match, in the reviewing engine's words", async () => {
  window.desktop = fakeDesktop();
  const reviews: unknown[] = [];
  const steps: string[] = [];
  const picker = (step: "targets" | "base") => renderConversationComposer({
    workspaceId: "workspace-1", engine: "codex", engineLabel: "Codex", model: "gpt-6-astra",
    reviewPicker: { taskId: "task-1", step },
    onReview: (target) => { reviews.push(target); },
    onReviewStep: (next) => { steps.push(next); },
  });
  const view = await mount(picker("targets"));
  assert.match(query(view.container, ".review-menu").textContent ?? "", /Tell Codex what to inspect/);
  await view.render(picker("base"));
  await settleUntil(() => view.container.querySelectorAll(".review-branch-list > button").length > 0);
  const search = query<HTMLInputElement>(view.container, ".review-search input");
  const setValue = item(Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")).set;
  await act(async () => {
    item(setValue).call(search, "fix");
    search.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true }));
  });
  await act(async () => { search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  assert.deepEqual(reviews, [{ type: "baseBranch", branch: "fix-loader" }]);
  assert.match(query(view.container, ".review-back").dataset.tip ?? "", /^Back \(Esc(ape)?\)$/);
  await view.unmount();
});
