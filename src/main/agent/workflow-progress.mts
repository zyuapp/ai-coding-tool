import type { WorkflowAgent, WorkflowAgentState, WorkflowPhase } from "../../domain/workflow.js";

/**
 * The workflow tree the agent SDK sends on `task_progress`. It is absent from the SDK's own types,
 * and every field here is read defensively so a shape change costs the panel a field, not the run.
 */
export type WorkflowProgressSnapshot = {
  phases: WorkflowPhase[];
  agents: WorkflowAgent[];
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}

function count(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function flag(value: unknown) {
  return value === true ? true : undefined;
}

/** A queued agent reports `start` before it has a start time; only a time means it is really running. */
function agentState(value: unknown, startedAt: number | undefined): WorkflowAgentState {
  if (value === "done") return "done";
  if (value === "error") return "error";
  if (value === "progress") return "running";
  return startedAt === undefined ? "queued" : "running";
}

function isolationOf(value: unknown) {
  return value === "worktree" || value === "remote" ? value : undefined;
}

function optional<T>(key: string, value: T | undefined) {
  return value === undefined ? {} : { [key]: value };
}

function readAgent(entry: Record<string, unknown>): WorkflowAgent | null {
  const index = count(entry.index);
  if (index === undefined) return null;
  const startedAt = count(entry.startedAt);
  return {
    index,
    label: text(entry.label) ?? `Agent ${index + 1}`,
    state: agentState(entry.state, startedAt),
    ...optional("phaseIndex", count(entry.phaseIndex)),
    ...optional("phaseTitle", text(entry.phaseTitle)),
    ...optional("agentId", text(entry.agentId)),
    ...optional("agentType", text(entry.agentType)),
    ...optional("model", text(entry.model)),
    ...optional("isolation", isolationOf(entry.isolation)),
    ...optional("cached", flag(entry.cached)),
    ...optional("attempt", count(entry.attempt)),
    ...optional("lastAttemptReason", text(entry.lastAttemptReason)),
    ...optional("lastToolName", text(entry.lastToolName)),
    ...optional("lastToolSummary", text(entry.lastToolSummary)),
    ...optional("promptPreview", text(entry.promptPreview)),
    ...optional("resultPreview", text(entry.resultPreview)),
    ...optional("error", text(entry.error)),
    ...optional("queuedAt", count(entry.queuedAt)),
    ...optional("startedAt", startedAt),
    ...optional("durationMs", count(entry.durationMs)),
    ...optional("lastProgressAt", count(entry.lastProgressAt)),
    ...optional("tokens", count(entry.tokens)),
    ...optional("toolCalls", count(entry.toolCalls)),
  };
}

function readPhase(entry: Record<string, unknown>): WorkflowPhase | null {
  const index = count(entry.index);
  const title = text(entry.title);
  return index === undefined || title === undefined ? null : { index, title };
}

/**
 * Reads one progress payload whole. The workflow republishes its entire tree each time, so the
 * result replaces what came before rather than merging into it.
 */
export function parseWorkflowProgress(value: unknown): WorkflowProgressSnapshot | null {
  if (!Array.isArray(value)) return null;
  const phases: WorkflowPhase[] = [];
  const agents = new Map<number, WorkflowAgent>();
  for (const item of value) {
    const entry = record(item);
    if (!entry) continue;
    if (entry.type === "workflow_phase") {
      const phase = readPhase(entry);
      if (phase) phases.push(phase);
    } else if (entry.type === "workflow_agent") {
      const agent = readAgent(entry);
      if (agent) agents.set(agent.index, agent);
    }
  }
  return { phases, agents: [...agents.values()] };
}

/** The field the SDK's own `task_progress` type does not declare. */
export function workflowProgressOf(message: object): unknown {
  return (message as { workflow_progress?: unknown }).workflow_progress;
}
