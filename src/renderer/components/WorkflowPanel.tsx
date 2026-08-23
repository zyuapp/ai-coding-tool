import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, Boxes, CheckCircle2, CircleDot, Clock, Square, XCircle } from "lucide-react";
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
} from "../../domain/workflow";

/** How often a running workflow redraws. Its own frames are far rarer, so lanes would jump without it. */
const TICK_MS = 1_000;

function useClock(live: boolean) {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setClock(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [live]);
  return live ? clock : Date.now();
}

function AgentIcon({ state }: { state: WorkflowAgentState }) {
  if (state === "done") return <CheckCircle2 size={15} />;
  if (state === "error") return <XCircle size={15} />;
  if (state === "queued") return <Clock size={15} />;
  if (state === "stopped") return <Square size={15} />;
  return <CircleDot className="agent-working-icon" size={15} />;
}

function tokens(value: number) {
  return value.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });
}

function AgentBadges({ agent }: { agent: WorkflowAgent }) {
  return (
    <>
      {agent.model && <span className="workflow-badge">{agent.model}</span>}
      {agent.isolation && <span className="workflow-badge isolation">{agent.isolation}</span>}
      {agent.cached && <span className="workflow-badge cached">cached</span>}
      {agent.attempt !== undefined && agent.attempt > 1 && (
        <span className="workflow-badge retry" title={agent.lastAttemptReason}>retry {agent.attempt}</span>
      )}
    </>
  );
}

function AgentRow({ agent, state, now, onSelect }: { agent: WorkflowAgent; state: WorkflowAgentState; now: number; onSelect: () => void }) {
  const duration = workflowAgentDuration(agent, now);
  return (
    <button className="workflow-row" type="button" onClick={onSelect} aria-label={`Open ${agent.label} details`}>
      <span className={`agent-orb ${state}`}><AgentIcon state={state} /></span>
      <span className="workflow-row-main">
        <span className="workflow-row-label"><strong>{agent.label}</strong><AgentBadges agent={agent} /></span>
        <small className={state === "error" ? "failed" : ""}>{workflowAgentNote(agent, state)}</small>
      </span>
      <span className="workflow-row-spend">
        {agent.tokens ? <span>{tokens(agent.tokens)}</span> : null}
        {duration === undefined ? null : <small>{formatElapsed(duration)}</small>}
      </span>
    </button>
  );
}

/** Every agent on one clock: queue time hollow, run time filled, all lanes sharing the same origin. */
function Timeline({ workflow, now, onSelect }: { workflow: Workflow; now: number; onSelect: (index: number) => void }) {
  const span = useMemo(() => workflowSpan(workflow, now), [workflow, now]);
  const ticks = useMemo(() => workflowTicks(span), [span]);
  const groups = useMemo(() => workflowGroups(workflow), [workflow]);

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
              <button className="workflow-lane" type="button" key={agent.index} onClick={() => onSelect(agent.index)} aria-label={`Open ${agent.label} details`}>
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
    <div className="workflow-inspect">
      <button className="session-back" type="button" onClick={onBack}><ArrowLeft size={15} />{workflow.name}</button>
      <div className="workflow-inspect-body">
        <div className="workflow-inspect-heading">
          <span className={`agent-orb ${state}`}><AgentIcon state={state} /></span>
          <div>
            <h2>{agent.label}</h2>
            <p>{agent.phaseTitle ? `${agent.phaseTitle} · ` : ""}{workflowAgentNote(agent, state)}</p>
          </div>
        </div>
        <div className="workflow-chips"><AgentBadges agent={agent} />{agent.agentType && <span className="workflow-badge">{agent.agentType}</span>}</div>
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
      <header className="workflow-head">
        <div className="workflow-head-top">
          <span className={`agent-orb ${live ? "" : workflow.status === "completed" ? "done" : "error"}`}><Boxes size={15} /></span>
          <h2>{workflow.name}</h2>
          {live && (
            <button className="workflow-stop" type="button" disabled={workflow.stopping} onClick={() => onStop(workflow.id)}>
              {workflow.stopping ? "Stopping" : "Stop"}
            </button>
          )}
        </div>
        <p className="workflow-head-sub">
          {workflowStatusLabel(workflow)} · {workflow.agents.length} {workflow.agents.length === 1 ? "agent" : "agents"} · {formatElapsed(now - workflow.startedAt)}
        </p>
        <div className="workflow-stats">
          <div><strong>{done}/{workflow.agents.length}</strong><span>Agents</span></div>
          <div><strong>{tokens(workflow.totalTokens)}</strong><span>Tokens</span></div>
          <div><strong>{workflow.totalToolCalls}</strong><span>Tool calls</span></div>
          {failed > 0 && <div className="failed"><strong>{failed}</strong><span>Failed</span></div>}
        </div>
        <div className="workflow-meter">
          <i style={{ width: `${workflow.agents.length ? done / workflow.agents.length * 100 : 0}%` }} />
        </div>
      </header>

      <div className="workflow-body">
        {workflow.agents.length === 0 ? (
          <p className="session-empty">Waiting for the workflow's first agents…</p>
        ) : (
          <>
            <Timeline workflow={workflow} now={now} onSelect={setSelected} />
            {groups.map((group) => {
              const groupDone = group.agents.filter((item) => item.state === "done" || item.state === "error").length;
              return (
                <section className="workflow-group" key={group.key}>
                  <div className="workflow-group-head">
                    <h3>{group.title}</h3>
                    <span>{groupDone}/{group.agents.length}</span>
                  </div>
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
