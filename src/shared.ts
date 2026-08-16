export type PermissionMode = "default" | "plan" | "acceptEdits" | "auto";

export type ChatMessage = {
  id: string;
  kind: "user" | "assistant" | "tool" | "system";
  text: string;
  detail?: string;
  at: number;
};

export type Task = {
  id: string;
  title: string;
  folder: string;
  sessionId?: string;
  mode: PermissionMode;
  messages: ChatMessage[];
  changedFiles: string[];
  updatedAt: number;
};

export type AgentRequest =
  | {
      type: "start";
      requestId: string;
      prompt: string;
      cwd: string;
      projectless?: boolean;
      mode: PermissionMode;
      sessionId?: string;
    }
  | { type: "cancel" }
  | { type: "approval"; approvalId: string; allow: boolean };

export type ApprovalRequest = {
  approvalId: string;
  title: string;
  description: string;
  toolName: string;
  input: Record<string, unknown>;
};

export type AgentEvent =
  | { type: "status"; status: "running" | "idle" | "stopped" }
  | { type: "session"; sessionId: string }
  | { type: "assistant"; id: string; text: string }
  | { type: "tool"; id: string; toolName: string; input: Record<string, unknown> }
  | { type: "approval"; request: ApprovalRequest }
  | { type: "result"; text: string; isError: boolean }
  | { type: "error"; message: string };

export type DesktopAPI = {
  openFolder(): Promise<string | null>;
  send(request: AgentRequest): void;
  onAgentEvent(listener: (event: AgentEvent) => void): () => void;
  changedFiles(folder: string): Promise<string[]>;
};
