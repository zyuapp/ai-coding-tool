import assert from "node:assert/strict";
import React, { act } from "react";
import { test } from "vitest";
import { mount, query } from "../../support/renderer-dom.mts";
import { MessageArtifactScope } from "../../../src/renderer/components/MarkdownMessage.tsx";
import { TimelineRow } from "../../../src/renderer/components/TimelineRow.tsx";

test("a timeline thumbnail and its viewer both address the thread that holds the attachment", async () => {
  const opened: string[] = [];
  const view = await mount(React.createElement(MessageArtifactScope.Provider, { value: { root: "/linux", taskId: "remote-thread" } },
    React.createElement(TimelineRow, {
      engine: "claude", index: 0, offset: 0, measure: () => {},
      group: { kind: "message", id: "message", message: { id: "message", kind: "user", text: "Look here", at: 1, attachments: ["/linux/attachments/shot.png"] } },
      onViewAttachment: (source) => opened.push(source),
    }),
  ));
  const source = "attachment://file/shot.png?taskId=remote-thread";
  assert.equal(query<HTMLImageElement>(document, ".message-attachment img").src, source);
  await act(async () => query<HTMLButtonElement>(document, ".message-attachment").click());
  assert.deepEqual(opened, [source]);
  await view.unmount();
});
