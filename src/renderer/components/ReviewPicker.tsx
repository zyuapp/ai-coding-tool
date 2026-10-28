import { LuChevronLeft as ChevronLeft, LuGitBranch as GitBranch, LuGitCommitHorizontal as GitCommit, LuListChecks as ListChecks, LuMessageSquareText as MessageSquareText, LuSearch as Search, LuX as X } from "react-icons/lu";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import type { ReviewPicker as ReviewPickerState } from "../../application/workspace-state";
import type { ReviewTarget } from "../../domain/review";
import type { BranchesResult } from "../../contracts/ipc";
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

function targets(engineLabel: string) {
  return [
    { step: "base" as const, label: "Review against a base branch", description: "Compare this branch with another branch.", icon: GitBranch },
    { target: { type: "uncommittedChanges" } as const, label: "Review uncommitted changes", description: "Review staged, unstaged, and untracked changes.", icon: ListChecks },
    { step: "commit" as const, label: "Review a commit", description: "Review the changes introduced by one commit.", icon: GitCommit },
    { step: "custom" as const, label: "Custom review instructions", description: `Tell ${engineLabel} what to inspect.`, icon: MessageSquareText },
  ];
}

function Heading({ step, current, onBack, onClose }: { step: ReviewPickerState["step"]; current?: string | null; onBack: () => void; onClose: () => void }) {
  const title = step === "base" && current
    ? <>Compare <code>{current}</code> with…</>
    : { targets: "Choose a review", base: "Choose a base branch", commit: "Review a commit", custom: "Custom review" }[step];
  return (
    <div className="command-menu-heading review-heading">
      {step === "targets"
        ? <ListChecks size={14} aria-hidden="true" />
        : <button type="button" className="review-back" aria-label="Back to review options" data-tip={shortcutTip("Back", "Escape")} onClick={onBack}><ChevronLeft size={16} /></button>}
      <span>{title}</span>
      {(step === "targets" || step === "base") && <kbd aria-hidden="true">↑↓</kbd>}
      <kbd aria-hidden="true">{displayShortcut("Escape", MAC)}</kbd>
      <button type="button" className="review-close" aria-label="Close review picker" data-tip={step === "targets" ? shortcutTip("Close", "Escape") : "Close"} onClick={onClose}><X size={16} /></button>
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

/** The search field keeps focus; arrow keys move the highlighted branch, which Enter takes. */
function BaseBranchPicker({ branches, onReview }: Pick<ReviewPickerProps, "onReview"> & { branches: BranchesResult | null }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);
  const available = branches?.status === "available" ? branches : null;
  const names = useMemo(() => {
    const candidates = [...new Set([...(available?.branches ?? []), ...(available?.remotes ?? [])])]
      .filter((branch) => branch !== available?.current);
    return matchBranches(candidates, query);
  }, [available, query]);
  const chosen = names.length ? Math.min(active, names.length - 1) : -1;
  useEffect(() => {
    list.current?.children[chosen]?.scrollIntoView?.({ block: "nearest" });
  }, [chosen]);
  return (
    <div className="review-branch-stage">
      <label className="review-search">
        <Search size={14} aria-hidden="true" />
        <input
          autoFocus
          role="combobox"
          aria-label="Search base branches"
          aria-autocomplete="list"
          aria-expanded={names.length > 0}
          aria-controls={listId}
          aria-activedescendant={chosen < 0 ? undefined : `${listId}-${chosen}`}
          placeholder="Search branches"
          spellCheck={false}
          value={query}
          onChange={(event) => { setQuery(event.target.value); setActive(0); }}
          onKeyDown={(event) => {
            if ((event.key === "ArrowDown" || event.key === "ArrowUp") && names.length) {
              event.preventDefault();
              setActive((chosen + (event.key === "ArrowDown" ? 1 : names.length - 1)) % names.length);
            } else if (event.key === "Enter" && chosen >= 0) {
              event.preventDefault();
              onReview({ type: "baseBranch", branch: names[chosen]! });
            }
          }}
        />
      </label>
      <div ref={list} id={listId} className="review-branch-list" role="listbox" aria-label="Base branches">
        {names.map((branch, index) => (
          <button
            type="button"
            role="option"
            id={`${listId}-${index}`}
            className={index === chosen ? "active" : undefined}
            aria-selected={index === chosen}
            tabIndex={-1}
            key={branch}
            onMouseEnter={() => setActive(index)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onReview({ type: "baseBranch", branch })}
          >
            <GitBranch size={14} aria-hidden="true" /><code>{branch}</code>
          </button>
        ))}
        {!branches && <p className="command-empty">Reading branches…</p>}
        {branches?.status === "error" && <p className="review-error" role="alert">{branches.message}</p>}
        {available && names.length === 0 && <p className="command-empty">{query.trim() ? "No branch matches" : "No other branch to compare with"}</p>}
      </div>
    </div>
  );
}

/** Up to a SHA-256 object name; fewer than four characters is still being typed. */
const COMMIT_SHA = /^[0-9a-f]{4,64}$/i;

function CommitPicker({ onReview }: Pick<ReviewPickerProps, "onReview">) {
  const [sha, setSha] = useState("");
  const errorId = useId();
  const commit = sha.trim();
  const valid = COMMIT_SHA.test(commit);
  const invalid = !valid && (/[^0-9a-f]/i.test(commit) || commit.length > 64);
  const short = !valid && !invalid && commit.length > 0;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (valid) onReview({ type: "commit", sha: commit, title: null });
  }
  return (
    <form className="review-form" onSubmit={submit}>
      <label><span>Commit SHA</span><input
        autoFocus
        spellCheck={false}
        placeholder="e.g. a1b2c3d"
        value={sha}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid || short ? errorId : undefined}
        onChange={(event) => setSha(event.target.value)}
      /></label>
      {invalid && <p id={errorId} className="review-form-error" role="alert">Enter a hex commit SHA</p>}
      {short && <p id={errorId} className="review-form-hint">At least 4 characters</p>}
      <div className="review-form-actions"><button type="submit" className="primary" disabled={!valid}>Start review <kbd aria-hidden="true">{displayShortcut("Enter", MAC)}</kbd></button></div>
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
        onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) submit(event); }}
      /></label>
      <div className="review-form-actions"><button type="submit" className="primary" disabled={!custom}>Start review <kbd aria-hidden="true">{displayShortcut("Enter", MAC)}</kbd></button></div>
    </form>
  );
}

/** The engine's review preset picker, kept in the composer instead of opening a separate settings dialog. */
export function ReviewPicker({ picker, workspaceId, engineLabel, returnFocus, onStep, onReview, onClose }: ReviewPickerProps) {
  const root = useRef<HTMLDivElement>(null);
  const branches = useBranches(workspaceId, picker.step === "base");
  useDismissibleLayer(true, [root], onClose, returnFocus);
  function keyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (picker.step === "targets") onClose();
    else onStep("targets");
  }
  return (
    <div ref={root} id="review-picker" className="command-menu review-menu" role="dialog" aria-label="Start code review" onKeyDown={keyDown}>
      <Heading step={picker.step} current={branches?.status === "available" ? branches.current : null} onBack={() => onStep("targets")} onClose={onClose} />
      {picker.step === "targets" && <TargetOptions engineLabel={engineLabel} onStep={onStep} onReview={onReview} />}
      {picker.step === "base" && <BaseBranchPicker branches={branches} onReview={onReview} />}
      {picker.step === "commit" && <CommitPicker onReview={onReview} />}
      {picker.step === "custom" && <CustomPicker engineLabel={engineLabel} onReview={onReview} />}
    </div>
  );
}
