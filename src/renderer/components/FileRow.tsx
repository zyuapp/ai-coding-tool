import { LuFile as FileMark, LuFolder as Folder } from "react-icons/lu";
import type { AttachedFile } from "../../domain/conversation";
import { AttachedPill, AttachedRow } from "./AttachedPill";
import { useMessageLinks } from "./MarkdownMessage";

/** Attached files as pills: removable while drafted in a composer, read-only on a sent message. */
export function FileRow({ files, onRemove }: {
  files: AttachedFile[];
  onRemove?: (fileId: string) => void;
}) {
  const links = useMessageLinks();
  if (files.length === 0) return null;

  return (
    <AttachedRow className="file-row" label="Attached files">
      {files.map((file) => (
        <AttachedPill
          key={file.id}
          className="file-pill"
          removeLabel={`Remove ${file.name}`}
          removeClassName="file-remove"
          onRemove={onRemove && (() => onRemove(file.id))}
        >
          {file.folder ? (
            <span className="attached-pill-face file-name" data-tip={file.path}>
              <Folder size={12} aria-hidden="true" />
              <strong>{file.name}</strong>
              <small>Folder</small>
            </span>
          ) : (
            <button type="button" className="attached-pill-face file-name" data-tip={file.path} onClick={() => links.openFile?.(file.path, null)} aria-label={`Open ${file.name}`}>
              <FileMark size={12} aria-hidden="true" />
              <strong>{file.name}</strong>
            </button>
          )}
        </AttachedPill>
      ))}
    </AttachedRow>
  );
}
