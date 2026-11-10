import { useEffect, useMemo, useState } from "react";
import { useSecondClock } from "../second-clock";
import { shortcutTip } from "./TooltipLayer";
import { ConfirmAction } from "../ui/ConfirmAction";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { EmptyState } from "../ui/EmptyState";
import { ListHeading, ListRow } from "../ui/List";
import { Meter } from "../ui/Meter";
import { PanelHeader } from "../ui/PanelHeader";
import { LuArrowLeft as ArrowLeft, LuBoxes as Boxes, LuCircleCheckBig as CheckCircle2, LuCircleDot as CircleDot, LuCircleX as XCircle, LuClock as Clock, LuSquare as Square, LuTriangleAlert as AlertTriangle } from "react-icons/lu";
import {
  agentStateIn,
  formatElapsed,
  workflowAgentDuration,
  workflowAgentNote,
  workflowAgentCounts,
  workflowBar,
  workflowGroups,
  workflowNow,
  workflowSpan,
  workflowStatusLabel,
  workflowTicks,
  type Workflow,
  type WorkflowAgent,
  type WorkflowAgentState,
  type WorkflowGroup,
} from "../../domain/workflow";

/** A running workflow redraws each second. Its own frames are far rarer, so lanes would jump without it. */
const useClock = useSecondClock;

function AgentIcon({ state }: { state: WorkflowAgentState }) {
  if (state === "done") return <CheckCircle2 size={16} />;
  if (state === "error") return <XCircle size={16} />;
  if (state === "queued") return <Clock size={16} />;
  if (state === "stopped") return <Square size={16} />;
  return <CircleDot className="agent-working-icon" size={16} />;
}

function tokens(value: number) {
  return value.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });
}

function AgentBadges({ agent }: { agent: WorkflowAgent }) {
  return (
    <>
      {agent.model && <Chip variant="tag" className="workflow-badge">{agent.model}</Chip>}
      {agent.isolation && <Chip variant="tag" tone="info" className="workflow-badge isolation">{agent.isolation}</Chip>}
      {agent.cached && <Chip variant="tag" tone="success" className="workflow-badge cached">cached</Chip>}
      {agent.attempt !== undefined && agent.attempt > 1 && (
        <Chip variant="tag" tone="accent" className="workflow-badge retry" data-tip={agent.lastAttemptReason}>retry {agent.attempt}</Chip>
      )}
    </>
  );
}

function AgentRow({ agent, state, now, onSelect }: { agent: WorkflowAgent; state: WorkflowAgentState; now: number; onSelect: () => void }) {
  const duration = workflowAgentDuration(agent, now);
  return (
    <ListRow
      className="workflow-row"
      data-state={state}
      aria-label={`Open ${agent.label} details`}
      leading={<span className={`agent-orb ${state}`}><AgentIcon state={state} /></span>}
      title={<span className="workflow-row-label"><span>{agent.label}</span><AgentBadges agent={agent} /></span>}
      detail={workflowAgentNote(agent, state)}
      trailing={(
        <span className="workflow-row-spend">
          {agent.tokens ? <span>{tokens(agent.tokens)}</span> : null}
          {duration === undefined ? null : <small>{formatElapsed(duration)}</small>}
        </span>
      )}
      onClick={onSelect}
    />
  );
}

/** What a lane's bar colour says, for a reader who cannot see it. */
const LANE_STATES: Record<WorkflowAgentState, string> = { queued: "queued", running: "running", done: "done", error: "failed", stopped: "stopped" };

/** How long a lane's agent waited and ran, as its bar draws them. */
function laneTip(agent: WorkflowAgent, state: WorkflowAgentState, now: number) {
  const waited = agent.queuedAt !== undefined ? (agent.startedAt ?? now) - agent.queuedAt : undefined;
  const ran = workflowAgentDuration(agent, now);
  return [
    `${agent.label} · ${LANE_STATES[state]}`,
    ...(waited !== undefined ? [`waited ${formatElapsed(waited)}`] : []),
    ...(ran !== undefined ? [`ran ${formatElapsed(ran)}`] : []),
  ].join(" · ");
}

/** Every agent on one clock: queue time hollow, run time filled, all lanes sharing the same origin. */
function Timeline({ workflow, groups, now, onSelect }: { workflow: Workflow; groups: WorkflowGroup[]; now: number; onSelect: (index: number) => void }) {
  const span = useMemo(() => workflowSpan(workflow, now), [workflow, now]);
  const ticks = useMemo(() => workflowTicks(span), [span]);

  return (
    <section className="workflow-timeline" aria-label="Workflow timeline">
      <div className="workflow-axis">
        {ticks.map((tick) => <span key={tick.at} style={{ left: `${tick.left}%` }}>{tick.label}</span>)}
      </div>
      {groups.map((group) => (
        <div className="workflow-lane-group" key={group.key}>
          <h4>{group.title}</h4>
          {group.agents.map((agent) => {
            const state = agentStateIn(workflow, agent);
            const bar = workflowBar(agent, span, now);
            return (
              <button className="workflow-lane" type="button" key={agent.index} onClick={() => onSelect(agent.index)} aria-label={`Open ${agent.label} details, ${LANE_STATES[state]}`} data-tip={laneTip(agent, state, now)}>
                <span className="workflow-lane-name">{agent.label}</span>
                <span className="workflow-lane-track">
                  {bar.queue && <i className="queue" style={{ left: `${bar.queue.left}%`, width: `${bar.queue.width}%` }} />}
                  {bar.run && <i className={`run ${state}`} style={{ left: `${bar.run.left}%`, width: `${bar.run.width}%` }} />}
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </section>
  );
}

function AgentInspector({ workflow, agent, now, onBack }: { workflow: Workflow; agent: WorkflowAgent; now: number; onBack: () => void }) {
  const state = agentStateIn(workflow, agent);
  const duration = workflowAgentDuration(agent, now);
  const waited = agent.queuedAt !== undefined && agent.startedAt !== undefined ? agent.startedAt - agent.queuedAt : undefined;

  return (
    <div className="workflow-inspect" onKeyDown={(event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onBack();
    }}>
      <Button className="session-back" variant="ghost" icon={<ArrowLeft size={16} aria-hidden="true" />} autoFocus data-tip={shortcutTip("Back", "Escape")} onClick={onBack}>{workflow.name}</Button>
      <div className="workflow-inspect-body">
        <div className="workflow-inspect-heading">
          <span className={`agent-orb ${state}`}><AgentIcon state={state} /></span>
          <div>
            <h2>{agent.label}</h2>
            <p>{agent.phaseTitle ? `${agent.phaseTitle} · ` : ""}{workflowAgentNote(agent, state)}</p>
          </div>
        </div>
        <div className="workflow-chips"><AgentBadges agent={agent} />{agent.agentType && <Chip variant="tag" className="workflow-badge">{agent.agentType}</Chip>}</div>
        <dl className="workflow-facts">
          {waited !== undefined && <><dt>Waited</dt><dd>{formatElapsed(waited)}</dd></>}
          {duration !== undefined && <><dt>Ran</dt><dd>{formatElapsed(duration)}</dd></>}
          {agent.tokens !== undefined && <><dt>Tokens</dt><dd>{agent.tokens.toLocaleString()}</dd></>}
          {agent.toolCalls !== undefined && <><dt>Tool calls</dt><dd>{agent.toolCalls}</dd></>}
          {agent.lastToolName && <><dt>Last tool</dt><dd>{agent.lastToolName}</dd></>}
          {agent.agentId && <><dt>Agent id</dt><dd>{agent.agentId}</dd></>}
        </dl>
        {agent.lastToolSummary && <><h3>Last tool</h3><pre className="workflow-preview">{agent.lastToolSummary}</pre></>}
        {agent.promptPreview && <><h3>Prompt</h3><pre className="workflow-preview">{agent.promptPreview}</pre></>}
        {agent.error
          ? <><h3>Error</h3><pre className="workflow-preview failed">{agent.error}</pre></>
          : <><h3>Result</h3><pre className="workflow-preview">{agent.resultPreview ?? (state === "done" ? "Returned nothing" : "Pending")}</pre></>}
        <p className="workflow-note">Previews are the first 400 characters the workflow reported.</p>
      </div>
    </div>
  );
}

/**
 * One dynamic workflow, whole: what each phase has left to do, when each agent ran, and what any one
 * of them was given or came back with. Everything here arrives on the workflow's own progress frames,
 * so the panel shows what the last frame said and nothing more.
 */
export function WorkflowPanel({ workflow, onStop }: { workflow: Workflow; onStop: (id: string) => void }) {
  const [selected, setSelected] = useState<number | null>(null);
  const live = workflow.status === "running";
  const now = workflowNow(workflow, useClock(live));
  const groups = useMemo(() => workflowGroups(workflow), [workflow]);
  const { done, failed } = workflowAgentCounts(workflow);
  const agent = workflow.agents.find((candidate) => candidate.index === selected);

  useEffect(() => {
    setSelected(null);
  }, [workflow.id]);

  if (agent) return <AgentInspector workflow={workflow} agent={agent} now={now} onBack={() => setSelected(null)} />;

  return (
    <section className="workflow-panel" aria-label={`Workflow ${workflow.name}`}>
      <PanelHeader
        icon={<span className={`agent-orb ${live ? "" : workflow.status === "completed" ? "done" : "error"}`}><Boxes size={16} /></span>}
        title={workflow.name}
        subtitle={`${workflowStatusLabel(workflow)} · ${workflow.agents.length} ${workflow.agents.length === 1 ? "agent" : "agents"} · ${formatElapsed(now - workflow.startedAt)}`}
        actions={live ? (
          <span className="workflow-stop-actions">
            {workflow.stopping
              ? <Button className="workflow-stop" variant="danger" disabled>Stopping…</Button>
              : <ConfirmAction className="workflow-stop" variant="danger" confirm="Stop workflow" onConfirm={() => onStop(workflow.id)}>Stop</ConfirmAction>}
          </span>
        ) : undefined}
      />
      <div className="workflow-overview">
        <div className="workflow-stats">
          <div><strong>{done}/{workflow.agents.length}</strong><span>Agents</span></div>
          <div><strong>{tokens(workflow.totalTokens)}</strong><span>Tokens</span></div>
          <div><strong>{workflow.totalToolCalls}</strong><span>Tool calls</span></div>
          {failed > 0 && <div className="failed"><strong>{failed}</strong><span>Failed</span></div>}
        </div>
        <Meter size="hair" tone="info" value={workflow.agents.length ? done / workflow.agents.length : 0} />
      </div>

      <div className="workflow-body">
        {workflow.agents.length === 0 ? (
          <EmptyState size="inline" title="Waiting for the workflow's first agents…" />
        ) : (
          <>
            <Timeline workflow={workflow} groups={groups} now={now} onSelect={setSelected} />
            {groups.map((group) => {
              const groupDone = group.agents.filter((item) => item.state === "done" || item.state === "error").length;
              return (
                <section className="workflow-group" key={group.key}>
                  <ListHeading className="workflow-group-head" role="heading" aria-level={3} label={group.title} count={`${groupDone}/${group.agents.length}`} />
                  {group.agents.map((item) => (
                    <AgentRow key={item.index} agent={item} state={agentStateIn(workflow, item)} now={now} onSelect={() => setSelected(item.index)} />
                  ))}
                </section>
              );
            })}
          </>
        )}
        {workflow.status !== "running" && workflow.summary && (
          <p className="workflow-summary">{workflow.status === "failed" && <AlertTriangle size={14} />}{workflow.summary}</p>
        )}
      </div>
    </section>
  );
}
