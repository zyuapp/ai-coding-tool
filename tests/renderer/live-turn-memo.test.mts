import assert from "node:assert/strict";
import type { IconBaseProps } from "react-icons";
import { test, vi } from "vitest";
import { mount } from "../support/renderer-dom.mts";
import { timelineView, transcript } from "../support/timeline.mts";

const counts = vi.hoisted(() => ({ described: 0, timed: 0, glyphs: 0 }));
vi.mock("../../src/domain/tool-call.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/domain/tool-call.ts")>();
  return {
    ...actual,
    describeToolCall: (...args: Parameters<typeof actual.describeToolCall>) => {
      counts.described += 1;
      return actual.describeToolCall(...args);
    },
  };
});
vi.mock("../../src/renderer/timeline/grouping.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/renderer/timeline/grouping.ts")>();
  return {
    ...actual,
    timeSteps: (...args: Parameters<typeof actual.timeSteps>) => {
      counts.timed += 1;
      return actual.timeSteps(...args);
    },
  };
});
vi.mock("react-icons/lu", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-icons/lu")>();
  const counted = (Icon: (props: IconBaseProps) => React.ReactNode) => (props: IconBaseProps) => {
    counts.glyphs += 1;
    return Icon(props);
  };
  return { ...actual, LuTerminal: counted(actual.LuTerminal), LuFileText: counted(actual.LuFileText) };
});

test("a streaming tail does not rebuild or re-render the live turn's tool calls", async () => {
  const messages = transcript(
    { kind: "user", text: "Explain this" },
    { kind: "tool", text: "Bash", detail: JSON.stringify({ command: "ls" }, null, 2) },
    { kind: "tool", text: "Read", detail: JSON.stringify({ file_path: "src/a.ts" }, null, 2) },
    { kind: "assistant", text: "Looked around.\n\n" },
    { kind: "tool", text: "Bash", detail: JSON.stringify({ command: "pwd" }, null, 2) },
  );
  const view = await mount(timelineView(messages, "running", { messageId: "reply", text: "Here" }));
  const settled = { ...counts };
  assert.ok(settled.described > 0 && settled.timed > 0 && settled.glyphs > 0, "the tool runs are on screen");

  await view.render(timelineView(messages, "running", { messageId: "reply", text: "Here is" }));
  await view.render(timelineView(messages, "running", { messageId: "reply", text: "Here is what" }));

  assert.deepEqual(counts, settled);
  assert.match(view.container.textContent, /Here is what/);
  assert.match(view.container.textContent, /src\/a\.ts/);
  await view.unmount();
});
