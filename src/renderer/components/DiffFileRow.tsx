import { Check, ChevronDown, ChevronRight, FilePlus2, FileMinus2, FilePen, FileSymlink } from "lucide-react";
import type { DiffFileSummary } from "../../domain/diff";

function StatusIcon({ status }: { status: DiffFileSummary["status"] }) {
  if (status === "added" || status === "untracked") return <FilePlus2 size={15} />;
  if (status === "deleted") return <FileMinus2 size={15} />;
  if (status === "renamed") return <FileSymlink size={15} />;
  return <FilePen size={15} />;
}

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
    <div className={`diff-file-row ${viewed ? "viewed" : ""}`.trimEnd()}>
      <button className="diff-file-open" type="button" aria-expanded={open} {...reach} onClick={onToggle}>
        <span className="diff-file-caret" aria-hidden="true">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
        <span className="diff-file-icon"><StatusIcon status={file.status} /></span>
        <span className="diff-file-name" title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}>
          <em>{folder}</em>{name}
        </span>
        {file.previousPath && <span className="diff-file-renamed" title={`Renamed from ${file.previousPath}`}>renamed</span>}
        {!file.binary && <span className="change-counts"><strong>+{file.additions}</strong><em>−{file.deletions}</em></span>}
      </button>
      <button
        className="diff-file-editor"
        type="button"
        aria-label={`Open ${file.path} in your editor`}
        {...reach}
        onClick={() => onOpenFile(file.path)}
      >
        <FileSymlink size={14} />
      </button>
      <label className="diff-file-viewed">
        <input
          type="checkbox"
          aria-label={`Mark ${file.path} viewed`}
          {...reach}
          checked={viewed}
          onChange={(event) => onSetViewed(file.path, event.currentTarget.checked)}
        />
        <Check size={14} aria-hidden="true" />
      </label>
    </div>
  );
}
