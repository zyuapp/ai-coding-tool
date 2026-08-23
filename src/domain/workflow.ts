/** How far along one agent of a dynamic workflow is. `stopped` is the view's, never the run's. */
export type WorkflowAgentState = "queued" | "running" | "done" | "error" | "stopped";

/** A phase the workflow script declared. Agents name the phase they belong to by index. */
export type WorkflowPhase = {
  index: number;
  title: string;
};

/**
 * One agent the workflow spawned. Timings are epoch milliseconds from the agent process, so a lane
 * drawn from them lines up with every other agent in the same run.
 */
export type WorkflowAgent = {
  index: number;
  label: string;
  state: WorkflowAgentState;
  phaseIndex?: number;
  phaseTitle?: string;
  agentId?: string;
  agentType?: string;
  model?: string;
  isolation?: "worktree" | "remote";
  /** Replayed from an earlier run instead of spawned, so it costs nothing and ends immediately. */
  cached?: boolean;
  attempt?: number;
  lastAttemptReason?: string;
  lastToolName?: string;
  lastToolSummary?: string;
  promptPreview?: string;
  resultPreview?: string;
  error?: string;
  queuedAt?: number;
  startedAt?: number;
  durationMs?: number;
  lastProgressAt?: number;
  tokens?: number;
  toolCalls?: number;
};

export type WorkflowStatus = "running" | "completed" | "failed" | "stopped";

/**
 * A dynamic workflow the run is driving. The agent process reports the whole tree on every change,
 * so each record is a snapshot rather than something to amend.
 */
export type Workflow = {
  id: string;
  name: string;
  description: string;
  status: WorkflowStatus;
  phases: WorkflowPhase[];
  agents: WorkflowAgent[];
  totalTokens: number;
  totalToolCalls: number;
  startedAt: number;
  finishedAt?: number;
  summary?: string;
  /** Set from the moment a stop is asked for until the workflow reports how it ended. */
  stopping?: boolean;
};

export type WorkflowGroup = {
  key: string;
  title: string;
  agents: WorkflowAgent[];
};

/** Where a lane sits in the timeline, as percentages of the workflow's own span. */
export type WorkflowBar = {
  queue?: { left: number; width: number };
  run?: { left: number; width: number };
};

export type WorkflowSpan = { start: number; end: number };

export type WorkflowTick = { at: number; label: string; left: number };

const TICK_STEPS = [5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000];
const MAX_TICKS = 6;
/** A lane narrower than this reads as nothing at all, so instants are drawn at least this wide. */
const MIN_BAR_WIDTH = 0.6;

/** A workflow that ended took its unfinished agents with it, whatever its last frame said of them. */
export function agentStateIn(workflow: Workflow, agent: WorkflowAgent): WorkflowAgentState {
  if (workflow.status === "running") return agent.state;
  return agent.state === "queued" || agent.state === "running" ? "stopped" : agent.state;
}

/** The moment lanes are measured against: the workflow's end once it has one, otherwise the clock. */
export function workflowNow(workflow: Workflow, clock: number) {
  return workflow.finishedAt ?? clock;
}

export function workflowAgentsDone(workflow: Workflow) {
  return workflowAgentCounts(workflow).done;
}

export function workflowAgentsFailed(workflow: Workflow) {
  return workflowAgentCounts(workflow).failed;
}

export function workflowAgentCounts(workflow: Workflow) {
  let done = 0;
  let failed = 0;
  for (const agent of workflow.agents) {
    if (agent.state === "done" || agent.state === "error") done += 1;
    if (agent.state === "error") failed += 1;
  }
  return { done, failed };
}

/** Phase order first, then spawn order, with anything the script never gave a phase left to the end. */
export function workflowGroups(workflow: Workflow): WorkflowGroup[] {
  const byPhase = new Map<number, WorkflowAgent[]>();
  const loose: WorkflowAgent[] = [];
  for (const agent of [...workflow.agents].sort((left, right) => left.index - right.index)) {
    if (agent.phaseIndex === undefined) loose.push(agent);
    else {
      const bucket = byPhase.get(agent.phaseIndex);
      if (bucket) bucket.push(agent);
      else byPhase.set(agent.phaseIndex, [agent]);
    }
  }
  const phases = [...workflow.phases].sort((left, right) => left.index - right.index);
  const seen = new Set(phases.map((phase) => phase.index));
  for (const index of [...byPhase.keys()].sort((left, right) => left - right)) {
    if (!seen.has(index)) phases.push({ index, title: byPhase.get(index)![0]?.phaseTitle ?? `Phase ${index + 1}` });
  }
  const groups = phases
    .filter((phase) => byPhase.has(phase.index))
    .map((phase) => ({ key: `phase-${phase.index}`, title: phase.title, agents: byPhase.get(phase.index)! }));
  return loose.length ? [...groups, { key: "loose", title: "Agents", agents: loose }] : groups;
}

export function workflowAgentEnd(agent: WorkflowAgent, now: number) {
  if (agent.state !== "done" && agent.state !== "error") return now;
  if (agent.startedAt !== undefined && agent.durationMs !== undefined) return agent.startedAt + agent.durationMs;
  return agent.lastProgressAt ?? agent.startedAt ?? agent.queuedAt ?? now;
}

/** The window every lane is drawn against: the first thing that happened, until the workflow's end. */
export function workflowSpan(workflow: Workflow, now: number): WorkflowSpan {
  let start = workflow.startedAt;
  let end = workflow.finishedAt ?? now;
  for (const agent of workflow.agents) {
    if (agent.queuedAt !== undefined) start = Math.min(start, agent.queuedAt);
    if (agent.startedAt !== undefined) start = Math.min(start, agent.startedAt);
    end = Math.max(end, workflowAgentEnd(agent, now));
  }
  return { start, end: Math.max(end, start + 1) };
}

function place(from: number, to: number, span: WorkflowSpan) {
  const total = span.end - span.start;
  const left = Math.max(0, Math.min(100, (from - span.start) / total * 100));
  const width = Math.max(MIN_BAR_WIDTH, Math.min(100 - left, (to - from) / total * 100));
  return { left, width };
}

export function workflowBar(agent: WorkflowAgent, span: WorkflowSpan, now: number): WorkflowBar {
  const started = agent.startedAt ?? (agent.state === "queued" ? undefined : agent.queuedAt);
  const queued = agent.queuedAt !== undefined && (started === undefined || agent.queuedAt < started)
    ? place(agent.queuedAt, started ?? now, span)
    : undefined;
  const run = started === undefined ? undefined : place(started, workflowAgentEnd(agent, now), span);
  return { ...(queued ? { queue: queued } : {}), ...(run ? { run } : {}) };
}

/** Round marks along the span, chosen so the axis never carries more than a handful. */
export function workflowTicks(span: WorkflowSpan): WorkflowTick[] {
  const total = span.end - span.start;
  const step = TICK_STEPS.find((candidate) => total / candidate <= MAX_TICKS) ?? Math.ceil(total / MAX_TICKS);
  const ticks: WorkflowTick[] = [];
  for (let at = 0; at <= total; at += step) {
    ticks.push({ at, label: formatElapsed(at), left: at / total * 100 });
  }
  return ticks;
}

export function formatElapsed(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor(seconds % 3_600 / 60);
  const rest = seconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${minutes}:${String(rest).padStart(2, "0")}`;
}

export function workflowAgentDuration(agent: WorkflowAgent, now: number) {
  const started = agent.startedAt ?? agent.queuedAt;
  return started === undefined ? undefined : workflowAgentEnd(agent, now) - started;
}

/** One steady line per agent: what it is doing now, or what it came back with. */
export function workflowAgentNote(agent: WorkflowAgent, state: WorkflowAgentState = agent.state) {
  if (state === "error") return agent.error ?? "Failed";
  if (state === "stopped") return "Stopped with the run";
  if (state === "queued") return "Queued";
  if (state === "running") return agent.lastToolName ? `Using ${agent.lastToolName}` : "Working";
  if (agent.cached) return "Replayed from an earlier run";
  return agent.resultPreview?.split("\n").find((line) => line.trim()) ?? "Done";
}

export function workflowStatusLabel(workflow: Workflow) {
  if (workflow.stopping) return "Stopping";
  return { running: "Running", completed: "Completed", failed: "Failed", stopped: "Stopped" }[workflow.status];
}
