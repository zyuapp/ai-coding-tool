import { LuFile as FileMark, LuFolder as Folder, LuX as X } from "react-icons/lu";
import type { AttachedFile } from "../../domain/conversation";
import { useMessageLinks } from "./MarkdownMessage";

/** Attached files as pills: removable while drafted in a composer, read-only on a sent message. */
export function FileRow({ files, onRemove }: {
  files: AttachedFile[];
  onRemove?: (fileId: string) => void;
}) {
  const links = useMessageLinks();
  if (files.length === 0) return null;

  return (
    <div className="file-row" role="list" aria-label="Attached files">
      {files.map((file) => (
        <span className="file-pill" role="listitem" key={file.id}>
          {file.folder ? (
            <span className="file-name" title={file.path}>
              <Folder size={12} aria-hidden="true" />
              <strong>{file.name}</strong>
              <small>Folder</small>
            </span>
          ) : (
            <button type="button" className="file-name" title={file.path} onClick={() => links.openFile?.(file.path, null)} aria-label={`Open ${file.name}`}>
              <FileMark size={12} aria-hidden="true" />
              <strong>{file.name}</strong>
            </button>
          )}
          {onRemove && (
            <button type="button" className="file-remove" aria-label={`Remove ${file.name}`} onClick={() => onRemove(file.id)}>
              <X size={12} />
            </button>
          )}
        </span>
      ))}
    </div>
  );
}
