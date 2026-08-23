import { memo } from "react";
import { Boxes, Radio, Square, Terminal } from "lucide-react";
import type { BackgroundProcess } from "../../domain/run";
import { workflowAgentsDone, workflowStatusLabel, type Workflow } from "../../domain/workflow";

export function processLabel(process: BackgroundProcess) {
  if (process.stopping) return "Stopping";
  return process.kind === "shell" ? "Shell" : "Monitor";
}

export function workflowLabel(workflow: Workflow) {
  return `${workflowStatusLabel(workflow)} · ${workflowAgentsDone(workflow)}/${workflow.agents.length} agents`;
}

export const BackgroundProcessRow = memo(function BackgroundProcessRow({ process, onStop }: { process: BackgroundProcess; onStop: (processId: string) => void }) {
  return (
    <div className="process-row">
      <span className="agent-orb">{process.kind === "shell" ? <Terminal size={12} /> : <Radio size={12} />}</span>
      <span><strong>{process.description}</strong><small>{processLabel(process)}</small></span>
      <button
        className="process-stop"
        type="button"
        disabled={process.stopping}
        onClick={() => onStop(process.id)}
        aria-label={`Stop ${process.description}`}
      >
        <Square size={12} />
      </button>
    </div>
  );
});

/** A workflow is a process with a panel behind it, so the row opens rather than just reporting. */
export const WorkflowProcessRow = memo(function WorkflowProcessRow({ workflow, onOpen, onStop }: { workflow: Workflow; onOpen: (id: string) => void; onStop: (processId: string) => void }) {
  return (
    <div className="process-row">
      <button className="process-open" type="button" onClick={() => onOpen(workflow.id)} aria-label={`Open ${workflow.name} workflow`}>
        <span className={`agent-orb ${workflow.status === "running" ? "" : workflow.status === "completed" ? "done" : "error"}`}><Boxes size={12} /></span>
        <span><strong>{workflow.name}</strong><small>{workflowLabel(workflow)}</small></span>
      </button>
      {workflow.status === "running" && (
        <button
          className="process-stop"
          type="button"
          disabled={workflow.stopping}
          onClick={() => onStop(workflow.id)}
          aria-label={`Stop ${workflow.name}`}
        >
          <Square size={12} />
        </button>
      )}
    </div>
  );
});

type BackgroundProcessSectionProps = {
  processes: BackgroundProcess[];
  workflows: Workflow[];
  onOpenWorkflow: (id: string) => void;
  onStop: (processId: string) => void;
};

/** The processes the live run left running, and the workflows it drove while they were going. */
export function BackgroundProcessSection({ processes, workflows, onOpenWorkflow, onStop }: BackgroundProcessSectionProps) {
  const running = processes.length + workflows.filter((workflow) => workflow.status === "running").length;

  if (processes.length === 0 && workflows.length === 0) return null;

  return (
    <div className="subagent-section">
      <div className="subagent-heading">
        <span>Processes</span>
        {running > 0 && <span>{running} running</span>}
      </div>
      <div className="subagent-list" aria-live="polite">
        {workflows.map((workflow) => <WorkflowProcessRow key={workflow.id} workflow={workflow} onOpen={onOpenWorkflow} onStop={onStop} />)}
        {processes.map((process) => <BackgroundProcessRow key={process.id} process={process} onStop={onStop} />)}
      </div>
    </div>
  );
}
