import { clampTitle, type AttachedFile } from "../domain/task.js";

const FILE_HEADING = "Files and folders I attached to my message, by where they are on this machine:";

/** How attached files reach the agent: as locations to open, never as bytes the app read for it. */
export function promptWithFiles(text: string, files: AttachedFile[]) {
  if (files.length === 0) return text;
  const lines = files.map((file) => `${file.path}${file.folder ? " (folder)" : ""}`);
  return [text, `${FILE_HEADING}\n${lines.join("\n")}`].filter((part) => part.length > 0).join("\n\n");
}

/** What a thread dropped into with nothing typed is called. */
export function fileTitle(files: AttachedFile[]) {
  if (files.length === 0) return "";
  return clampTitle(files.length === 1 ? files[0].name : `${files.length} files`);
}
