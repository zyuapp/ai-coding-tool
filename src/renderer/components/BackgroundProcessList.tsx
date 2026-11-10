import { memo } from "react";
import { LuBoxes as Boxes, LuChevronRight as ChevronRight, LuLoaderCircle as LoaderCircle, LuRadio as Radio, LuSquare as Square, LuTerminal as Terminal } from "react-icons/lu";
import { processLabel, type BackgroundProcess } from "../../domain/run";
import { workflowLabel, type Workflow } from "../../domain/workflow";
import { ConfirmAction } from "../ui/ConfirmAction";
import { SpinningIcon } from "./SpinningIcon";
import { Button } from "../ui/Button";
import { ListHeading, ListRow } from "../ui/List";

/** Stop asks once more before it ends the process; while the stop is in flight a spinner holds its place. */
function StopButton({ name, stopping, onStop }: { name: string; stopping: boolean | undefined; onStop: () => void }) {
  return (
    <span className="process-stop-slot">
      {stopping
        ? <Button className="process-stop" variant="danger" disabled aria-label={`Stopping ${name}`} data-tip="Stopping…" icon={<SpinningIcon icon={LoaderCircle} spinning size={14} aria-hidden="true" />} />
        : <ConfirmAction className="process-stop" variant="danger" aria-label={`Stop ${name}`} data-tip="Stop" confirm="Stop" onConfirm={onStop} icon={<Square size={12} fill="currentColor" aria-hidden="true" />} />}
    </span>
  );
}

export const BackgroundProcessRow = memo(function BackgroundProcessRow({ process, onStop }: { process: BackgroundProcess; onStop: (processId: string) => void }) {
  return (
    <ListRow
      as="div"
      className="process-row"
      leading={<span className="agent-orb">{process.kind === "shell" ? <Terminal size={12} /> : <Radio size={12} />}</span>}
      title={process.description}
      detail={processLabel(process)}
      trailing={<StopButton name={process.description} stopping={process.stopping} onStop={() => onStop(process.id)} />}
    />
  );
});

/** A workflow is a process with a panel behind it, so the row opens rather than just reporting. */
export const WorkflowProcessRow = memo(function WorkflowProcessRow({ workflow, onOpen, onStop }: { workflow: Workflow; onOpen: (id: string) => void; onStop: (processId: string) => void }) {
  return (
    <div className="process-workflow">
      <ListRow
        className="process-open"
        leading={<span className={`agent-orb ${workflow.status === "running" ? "" : workflow.status === "completed" ? "done" : "error"}`}><Boxes size={12} /></span>}
        title={workflow.name}
        detail={workflowLabel(workflow)}
        trailing={<ChevronRight className="process-open-chevron" size={14} aria-hidden="true" />}
        onClick={() => onOpen(workflow.id)}
      />
      {workflow.status === "running" && <StopButton name={workflow.name} stopping={workflow.stopping} onStop={() => onStop(workflow.id)} />}
    </div>
  );
});

type BackgroundProcessSectionProps = {
  processes: BackgroundProcess[];
  workflows: Workflow[];
  onOpenWorkflow: (id: string) => void;
  onStop: (processId: string) => void;
};

/** The processes the thread session keeps running, and the workflows it drove while they were going. */
export function BackgroundProcessSection({ processes, workflows, onOpenWorkflow, onStop }: BackgroundProcessSectionProps) {
  const running = processes.length + workflows.filter((workflow) => workflow.status === "running").length;

  if (processes.length === 0 && workflows.length === 0) return null;

  return (
    <div className="subagent-section">
      <ListHeading className="session-heading" label="Processes" action={running > 0 ? <span className="session-heading-note">{running} running</span> : undefined} />
      <div className="subagent-list" aria-live="polite">
        {workflows.map((workflow) => <WorkflowProcessRow key={workflow.id} workflow={workflow} onOpen={onOpenWorkflow} onStop={onStop} />)}
        {processes.map((process) => <BackgroundProcessRow key={process.id} process={process} onStop={onStop} />)}
      </div>
    </div>
  );
}
