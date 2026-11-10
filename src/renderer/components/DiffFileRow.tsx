import { LuChevronDown as ChevronDown, LuChevronRight as ChevronRight, LuFilePlus2 as FilePlus2, LuFileMinus2 as FileMinus2, LuFilePen as FilePen, LuFileSymlink as FileSymlink, LuSquareArrowOutUpRight as OpenOut } from "react-icons/lu";
import type { DiffFileSummary } from "../../domain/diff";
import { IconButton } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { Checkbox } from "../ui/Field";
import "../ui/glass.css";

function StatusIcon({ status }: { status: DiffFileSummary["status"] }) {
  if (status === "added" || status === "untracked") return <FilePlus2 size={16} />;
  if (status === "deleted") return <FileMinus2 size={16} />;
  if (status === "renamed") return <FileSymlink size={16} />;
  return <FilePen size={16} />;
}

/** What the icon beside a name is saying, for a reader who has not learnt the four of them yet. */
const STATUS_TOOLTIPS: Record<DiffFileSummary["status"], string> = {
  added: "New file",
  untracked: "New, untracked",
  deleted: "Deleted file",
  renamed: "Moved file",
  modified: "Changed file",
};

/** The name a path is listed under, with its folder kept quiet beside it. */
function splitPath(path: string) {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? { folder: "", name: path } : { folder: path.slice(0, cut + 1), name: path.slice(cut + 1) };
}

type FileHeaderProps = {
  file: DiffFileSummary;
  open: boolean;
  viewed: boolean;
  /** Drawn as the pinned copy of a row the list already holds, so it is out of the tab order. */
  echo?: boolean;
  onToggle: () => void;
  onOpenFile: (path: string) => void;
  onSetViewed: (path: string, viewed: boolean) => void;
};

/** The row a file is headed by: what happened to it, what it cost, and whether it has been read. */
export function FileHeader({ file, open, viewed, echo = false, onToggle, onOpenFile, onSetViewed }: FileHeaderProps) {
  const { folder, name } = splitPath(file.path);
  const reach = echo ? { tabIndex: -1 } : {};
  return (
    <div className={["diff-file-row", viewed && "viewed", echo && "glass-strip"].filter(Boolean).join(" ")}>
      <button className="diff-file-open" type="button" aria-expanded={open} {...reach} onClick={onToggle}>
        <span className="diff-file-caret" aria-hidden="true" data-tip={open ? "Fold" : "Unfold"}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className="diff-file-icon" role="img" aria-label={STATUS_TOOLTIPS[file.status]} data-tip={STATUS_TOOLTIPS[file.status]}><StatusIcon status={file.status} /></span>
        <span className="diff-file-name" data-find-row={`${file.path}\n`} data-tip={file.path}>
          <em>{folder}</em>{name}
        </span>
        {file.previousPath && <Chip variant="tag" className="diff-file-renamed" data-tip={file.previousPath}>renamed</Chip>}
        {!file.binary && <span className="change-counts"><strong>+{file.additions}</strong><em>−{file.deletions}</em></span>}
      </button>
      <IconButton
        className="diff-file-editor"
        label={`Open ${file.path} in your editor`}
        tip="Open in editor"
        {...reach}
        onClick={() => onOpenFile(file.path)}
      >
        <OpenOut size={16} />
      </IconButton>
      <Checkbox
        wrapClassName="diff-file-viewed"
        tip={viewed ? "Mark unviewed" : "Mark viewed"}
        aria-label={`Mark ${file.path} viewed`}
        {...reach}
        checked={viewed}
        onChange={(event) => onSetViewed(file.path, event.currentTarget.checked)}
      />
    </div>
  );
}
