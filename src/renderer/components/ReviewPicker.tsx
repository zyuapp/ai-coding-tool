import { LuChevronLeft as ChevronLeft, LuGitBranch as GitBranch, LuGitCommitHorizontal as GitCommit, LuListChecks as ListChecks, LuMessageSquareText as MessageSquareText, LuSearch as Search } from "react-icons/lu";
import { useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import type { ReviewPicker as ReviewPickerState } from "../../application/workspace-state";
import type { ReviewTarget } from "../../domain/review";
import { moveListFocus, useDismissibleLayer } from "../focus";
import { matchBranches, useBranches } from "./BranchMenu";
import { MAC } from "../platform";
import { displayShortcut } from "../../domain/shortcuts";
import { shortcutTip } from "./TooltipLayer";

type ReviewPickerProps = {
  picker: ReviewPickerState;
  workspaceId?: string;
  /** What the engine that reviews is called, for wording that speaks of it. */
  engineLabel: string;
  returnFocus: RefObject<HTMLTextAreaElement | null>;
  onStep: (step: ReviewPickerState["step"]) => void;
  onReview: (target: ReviewTarget) => void;
  onClose: () => void;
};

const SUBMIT_KEYS = displayShortcut("Mod+Enter", MAC);

function targets(engineLabel: string) {
  return [
    { step: "base" as const, label: "Review against a base branch", description: "Compare this branch with another branch.", icon: GitBranch },
    { target: { type: "uncommittedChanges" } as const, label: "Review uncommitted changes", description: "Review staged, unstaged, and untracked changes.", icon: ListChecks },
    { step: "commit" as const, label: "Review a commit", description: "Review the changes introduced by one commit.", icon: GitCommit },
    { step: "custom" as const, label: "Custom review instructions", description: `Tell ${engineLabel} what to inspect.`, icon: MessageSquareText },
  ];
}

function Heading({ step, onBack }: { step: ReviewPickerState["step"]; onBack: () => void }) {
  const title = { targets: "Choose a review", base: "Choose a base branch", commit: "Review a commit", custom: "Custom review" }[step];
  return (
    <div className="command-menu-heading review-heading">
      {step === "targets"
        ? <ListChecks size={14} aria-hidden="true" />
        : <button type="button" className="review-back" aria-label="Back to review options" data-tip={shortcutTip("Back", "Escape")} onClick={onBack}><ChevronLeft size={16} /></button>}
      <span>{title}</span>
      {(step === "targets" || step === "base") && <kbd>↑↓</kbd>}
    </div>
  );
}

function TargetOptions({ engineLabel, onStep, onReview }: Pick<ReviewPickerProps, "engineLabel" | "onStep" | "onReview">) {
  const [focused, setFocused] = useState(0);
  return (
    <div className="command-menu-list review-targets" role="listbox" aria-label="Review options" onKeyDown={moveListFocus}>
      {targets(engineLabel).map((option, index) => {
        const Icon = option.icon;
        return (
          <button
            autoFocus={index === 0}
            type="button"
            className="command-option review-option"
            role="option"
            aria-selected={index === focused}
            key={option.label}
            onFocus={() => setFocused(index)}
            onMouseEnter={(event) => event.currentTarget.focus()}
            onClick={() => option.target ? onReview(option.target) : onStep(option.step)}
          >
            <span className="command-mark app" aria-hidden="true"><Icon size={16} /></span>
            <span className="command-copy"><strong>{option.label}</strong><small>{option.description}</small></span>
            <span className="command-source">{engineLabel}</span>
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
        <Search size={14} aria-hidden="true" />
        <input
          autoFocus
          aria-label="Search base branches"
          placeholder="Search branches"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || !names[0]) return;
            event.preventDefault();
            onReview({ type: "baseBranch", branch: names[0] });
          }}
        />
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
      <div className="review-form-actions"><button type="submit" className="primary" disabled={!commit}>Start review <kbd>{displayShortcut("Enter", MAC)}</kbd></button></div>
    </form>
  );
}

function CustomPicker({ engineLabel, onReview }: Pick<ReviewPickerProps, "engineLabel" | "onReview">) {
  const [instructions, setInstructions] = useState("");
  const custom = instructions.trim();
  function submit(event: FormEvent) {
    event.preventDefault();
    if (custom) onReview({ type: "custom", instructions: custom });
  }
  return (
    <form className="review-form" onSubmit={submit}>
      <label><span>Review instructions</span><textarea
        autoFocus
        rows={4}
        placeholder={`What should ${engineLabel} focus on?`}
        value={instructions}
        onChange={(event) => setInstructions(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit(event); }}
      /></label>
      <div className="review-form-actions"><button type="submit" className="primary" disabled={!custom}>Start review <kbd>{SUBMIT_KEYS}</kbd></button></div>
    </form>
  );
}

/** The engine's review preset picker, kept in the composer instead of opening a separate settings dialog. */
export function ReviewPicker({ picker, workspaceId, engineLabel, returnFocus, onStep, onReview, onClose }: ReviewPickerProps) {
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
      {picker.step === "targets" && <TargetOptions engineLabel={engineLabel} onStep={onStep} onReview={onReview} />}
      {picker.step === "base" && <BaseBranchPicker workspaceId={workspaceId} onReview={onReview} />}
      {picker.step === "commit" && <CommitPicker onReview={onReview} />}
      {picker.step === "custom" && <CustomPicker engineLabel={engineLabel} onReview={onReview} />}
    </div>
  );
}
