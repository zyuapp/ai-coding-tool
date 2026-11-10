import type { AgentEvent, RunCommand } from "./ipc.js";
import type { ThreadRequest, ThreadResponse } from "./threads.js";

/** The agent process: what runs are told, what they report, and the thread requests they make. */
export type RunPort = {
  runtime: {
    send(command: RunCommand): void;
    onAgentEvent(listener: (event: AgentEvent) => void): () => void;
    /** The window answers thread requests itself: it is the only process that holds workspace state. */
    onThreadRequest(listener: (request: ThreadRequest) => void): () => void;
    answerThreadRequest(response: ThreadResponse): void;
  };
};
