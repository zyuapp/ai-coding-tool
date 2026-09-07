import React from "react";
import type { ConversationComposerProps } from "../../src/renderer/components/ConversationComposer.tsx";
import "./renderer-dom.mts";

const { ConversationComposer } = await import("../../src/renderer/components/ConversationComposer.tsx");

export function composer(props: Partial<ConversationComposerProps>) {
  return React.createElement(ConversationComposer, {
    prompt: "",
    folder: "/project",
    workspaceId: "workspace-1",
    mode: "confirm",
    engine: "claude", engineLabel: "Claude",
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
