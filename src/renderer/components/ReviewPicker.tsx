import { LuChevronLeft as ChevronLeft, LuGitBranch as GitBranch, LuGitCommitHorizontal as GitCommit, LuListChecks as ListChecks, LuMessageSquareText as MessageSquareText, LuSearch as Search } from "react-icons/lu";
import { useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import type { ReviewPicker as ReviewPickerState } from "../../application/workspace-state";
import type { ReviewTarget } from "../../domain/review";
import { moveListFocus, useDismissibleLayer } from "../focus";
import { matchBranches, useBranches } from "./BranchMenu";

type ReviewPickerProps = {
  picker: ReviewPickerState;
  workspaceId?: string;
  returnFocus: RefObject<HTMLTextAreaElement | null>;
  onStep: (step: ReviewPickerState["step"]) => void;
  onReview: (target: ReviewTarget) => void;
  onClose: () => void;
};

const TARGETS = [
  { step: "base" as const, label: "Review against a base branch", description: "Compare this branch with another branch.", icon: GitBranch },
  { target: { type: "uncommittedChanges" } as const, label: "Review uncommitted changes", description: "Review staged, unstaged, and untracked changes.", icon: ListChecks },
  { step: "commit" as const, label: "Review a commit", description: "Review the changes introduced by one commit.", icon: GitCommit },
  { step: "custom" as const, label: "Custom review instructions", description: "Tell Codex what to inspect.", icon: MessageSquareText },
];

function Heading({ step, onBack }: { step: ReviewPickerState["step"]; onBack: () => void }) {
  const title = { targets: "Choose a review", base: "Choose a base branch", commit: "Review a commit", custom: "Custom review" }[step];
  return (
    <div className="command-menu-heading review-heading">
      {step === "targets"
        ? <ListChecks size={14} aria-hidden="true" />
        : <button type="button" className="review-back" aria-label="Back to review options" onClick={onBack}><ChevronLeft size={15} /></button>}
      <span>{title}</span>
      {(step === "targets" || step === "base") && <kbd>↑↓</kbd>}
    </div>
  );
}

function TargetOptions({ onStep, onReview }: Pick<ReviewPickerProps, "onStep" | "onReview">) {
  return (
    <div className="command-menu-list review-targets" role="listbox" aria-label="Review options" onKeyDown={moveListFocus}>
      {TARGETS.map((option, index) => {
        const Icon = option.icon;
        return (
          <button
            autoFocus={index === 0}
            type="button"
            className="command-option review-option"
            role="option"
            aria-selected={false}
            key={option.label}
            onClick={() => option.target ? onReview(option.target) : onStep(option.step)}
          >
            <span className="command-mark app" aria-hidden="true"><Icon size={15} /></span>
            <span className="command-copy"><strong>{option.label}</strong><small>{option.description}</small></span>
            <span className="command-source">Codex</span>
          </button>
        );
      })}
    </div>
  );
}

function BaseBranchPicker({ workspaceId, onReview }: Pick<ReviewPickerProps, "workspaceId" | "onReview">) {
  const branches = useBranches(workspaceId, true);
  const [query, setQuery] = useState("");
  const available = branches?.status === "available" ? branches : null;
  const names = useMemo(() => {
    const candidates = [...new Set([...(available?.branches ?? []), ...(available?.remotes ?? [])])]
      .filter((branch) => branch !== available?.current);
    return matchBranches(candidates, query);
  }, [available, query]);
  return (
    <div className="review-branch-stage" onKeyDown={moveListFocus}>
      <label className="review-search">
        <Search size={13} aria-hidden="true" />
        <input autoFocus aria-label="Search base branches" placeholder="Search branches" value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <div className="review-branch-list" role="listbox" aria-label="Base branches">
        {names.map((branch) => (
          <button type="button" role="option" aria-selected={false} key={branch} onClick={() => onReview({ type: "baseBranch", branch })}>
            <GitBranch size={14} aria-hidden="true" /><code>{branch}</code>
          </button>
        ))}
        {!branches && <p className="command-empty">Reading branches…</p>}
        {branches?.status === "error" && <p className="review-error" role="alert">{branches.message}</p>}
        {available && names.length === 0 && <p className="command-empty">No branch matches</p>}
      </div>
    </div>
  );
}

function CommitPicker({ onReview }: Pick<ReviewPickerProps, "onReview">) {
  const [sha, setSha] = useState("");
  const commit = sha.trim();
  function submit(event: FormEvent) {
    event.preventDefault();
    if (commit) onReview({ type: "commit", sha: commit, title: null });
  }
  return (
    <form className="review-form" onSubmit={submit}>
      <label><span>Commit SHA</span><input autoFocus spellCheck={false} placeholder="e.g. a1b2c3d" value={sha} onChange={(event) => setSha(event.target.value)} /></label>
      <div className="review-form-actions"><button type="submit" className="primary" disabled={!commit}>Start review</button></div>
    </form>
  );
}

function CustomPicker({ onReview }: Pick<ReviewPickerProps, "onReview">) {
  const [instructions, setInstructions] = useState("");
  const custom = instructions.trim();
  function submit(event: FormEvent) {
    event.preventDefault();
    if (custom) onReview({ type: "custom", instructions: custom });
  }
  return (
    <form className="review-form" onSubmit={submit}>
      <label><span>Review instructions</span><textarea autoFocus rows={4} placeholder="What should Codex focus on?" value={instructions} onChange={(event) => setInstructions(event.target.value)} /></label>
      <div className="review-form-actions"><button type="submit" className="primary" disabled={!custom}>Start review</button></div>
    </form>
  );
}

/** Codex's review preset picker, kept in the composer instead of opening a separate settings dialog. */
export function ReviewPicker({ picker, workspaceId, returnFocus, onStep, onReview, onClose }: ReviewPickerProps) {
  const root = useRef<HTMLDivElement>(null);
  useDismissibleLayer(true, [root], onClose, returnFocus);
  function keyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (picker.step === "targets") onClose();
    else onStep("targets");
  }
  return (
    <div ref={root} id="review-picker" className="command-menu review-menu" role="dialog" aria-label="Start code review" onKeyDown={keyDown}>
      <Heading step={picker.step} onBack={() => onStep("targets")} />
      {picker.step === "targets" && <TargetOptions onStep={onStep} onReview={onReview} />}
      {picker.step === "base" && <BaseBranchPicker workspaceId={workspaceId} onReview={onReview} />}
      {picker.step === "commit" && <CommitPicker onReview={onReview} />}
      {picker.step === "custom" && <CustomPicker onReview={onReview} />}
    </div>
  );
}
