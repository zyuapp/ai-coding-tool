import { useId } from "react";
import { LuShieldAlert as ShieldAlert } from "react-icons/lu";
import { displayShortcut, shortcutAction } from "../../domain/shortcuts";
import { MAC } from "../platform";
import { shortcutTip } from "./TooltipLayer";

export type ApprovalCardProps = {
  approval: {
    approvalId: string;
    taskId: string;
    runId: string;
    title: string;
    description: string;
    toolName: string;
    input: Record<string, unknown>;
  };
  onDecide: (approval: Pick<ApprovalCardProps["approval"], "taskId" | "runId" | "approvalId">, allow: boolean) => void;
  bindings?: DecideBindings;
};

/** The keystrokes Allow and Deny answer to; null where one is unbound. */
export type DecideBindings = { allow: string | null; deny: string | null };

const DEFAULT_BINDINGS: DecideBindings = { allow: shortcutAction("run.allow")?.defaultBinding ?? null, deny: shortcutAction("run.deny")?.defaultBinding ?? null };

/** Allow or Deny, with the keys that answer it beside its label. */
export function DecideButton({ label, binding, secondary = false, onDecide }: { label: string; binding: string | null; secondary?: boolean; onDecide: () => void }) {
  return (
    <button type="button" {...(secondary ? { className: "secondary" } : {})} {...(binding ? { "data-tip": shortcutTip(label, binding) } : {})} onClick={onDecide}>
      {label}{binding && <kbd aria-hidden="true">{displayShortcut(binding, MAC)}</kbd>}
    </button>
  );
}

const SUBJECT_KEYS = ["command", "file_path", "path", "url"] as const;

/**
 * What a tool call acts on, read in full: the shell command it would run, or the file or URL it
 * touches. `more` says the input holds other fields worth opening.
 */
export function approvalSubject(input: Record<string, unknown>): { text: string; more: boolean } | null {
  const key = SUBJECT_KEYS.find((item) => typeof input[item] === "string");
  if (!key) return null;
  return { text: input[key] as string, more: key !== "command" && Object.keys(input).length > 1 };
}

export function ApprovalCard({ approval, onDecide, bindings = DEFAULT_BINDINGS }: ApprovalCardProps) {
  const id = useId();
  const subject = approvalSubject(approval.input);
  return (
    <section className="approval-card" aria-labelledby={`${id}-title`} {...(approval.description ? { "aria-describedby": `${id}-description` } : {})}>
      <div className="approval-icon" aria-hidden="true"><ShieldAlert size={16} /></div>
      <div>
        <div role="alert">
          <strong id={`${id}-title`}>{approval.title}</strong>
          {approval.description && <p id={`${id}-description`}>{approval.description}</p>}
        </div>
        {subject && <pre className="approval-command">{subject.text}</pre>}
        {(!subject || subject.more) && <details>
          <summary>{approval.toolName}</summary>
          <pre>{JSON.stringify(approval.input, null, 2)}</pre>
        </details>}
        <div className="approval-actions">
          <DecideButton label="Deny" binding={bindings.deny} secondary onDecide={() => onDecide(approval, false)} />
          <DecideButton label="Allow once" binding={bindings.allow} onDecide={() => onDecide(approval, true)} />
        </div>
      </div>
    </section>
  );
}
