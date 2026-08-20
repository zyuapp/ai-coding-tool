/** How Claudex opens a source file: which editors it knows, and what to fall back to per platform. */

/** The platforms Claudex knows how to open a file on. Anything else falls through the whole chain. */
export type Platform = "darwin" | "win32" | "linux";

export type Launch = {
  command: string;
  args: string[];
};

/**
 * One place an editor's launcher might be. A bare name resolves on PATH; an absolute path is for
 * the platforms where it might not, since a desktop app inherits a stub PATH rather than a shell's.
 */
export type Candidate = Launch & { id: string };

type Editor = {
  id: string;
  name: string;
  /** Launcher locations by platform, in the order they are worth trying. */
  locations: Partial<Record<Platform, string[]>>;
  args: (file: string, line: number | null) => string[];
};

/** `--goto` takes the line as part of the path. Without one the plain path opens the file. */
const gotoArgs = (file: string, line: number | null) => (line ? ["-g", `${file}:${line}`] : [file]);

const suffixArgs = (file: string, line: number | null) => [line ? `${file}:${line}` : file];

/** Tried in order, so this doubles as which editor wins when someone has several installed. */
const EDITORS: Editor[] = [
  {
    id: "cursor",
    name: "Cursor",
    locations: {
      darwin: ["/Applications/Cursor.app/Contents/Resources/app/bin/cursor", "cursor"],
      win32: ["cursor.cmd"],
      linux: ["cursor"],
    },
    args: gotoArgs,
  },
  {
    id: "vscode",
    name: "Visual Studio Code",
    locations: {
      darwin: ["/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code", "code"],
      win32: ["code.cmd"],
      linux: ["code"],
    },
    args: gotoArgs,
  },
  {
    id: "windsurf",
    name: "Windsurf",
    locations: {
      darwin: ["/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf", "windsurf"],
      win32: ["windsurf.cmd"],
      linux: ["windsurf"],
    },
    args: gotoArgs,
  },
  {
    id: "zed",
    name: "Zed",
    locations: {
      darwin: ["/Applications/Zed.app/Contents/MacOS/cli", "zed"],
      linux: ["zed"],
    },
    args: suffixArgs,
  },
  {
    id: "sublime",
    name: "Sublime Text",
    locations: {
      darwin: ["/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl", "subl"],
      win32: ["subl.exe"],
      linux: ["subl"],
    },
    args: suffixArgs,
  },
  {
    id: "jetbrains",
    name: "JetBrains IDE",
    locations: {
      darwin: ["idea", "webstorm"],
      win32: ["idea.bat", "webstorm.bat"],
      linux: ["idea", "webstorm"],
    },
    args: (file, line) => (line ? ["--line", String(line), file] : [file]),
  },
];

export function editorName(id: string) {
  return EDITORS.find((editor) => editor.id === id)?.name ?? id;
}

/** Every launcher worth trying on this platform, best first, flattened across editors. */
export function editorCandidates(platform: Platform, file: string, line: number | null): Candidate[] {
  return EDITORS.flatMap((editor) =>
    (editor.locations[platform] ?? []).map((command) => ({
      id: editor.id,
      command,
      args: editor.args(file, line),
    })),
  );
}

/** The launcher a resolved editor uses next time, so a second click skips the ones that missed. */
export function editorLaunch(platform: Platform, command: string, file: string, line: number | null): Launch | null {
  const editor = EDITORS.find((candidate) => (candidate.locations[platform] ?? []).includes(command));
  return editor ? { command, args: editor.args(file, line) } : null;
}

/**
 * Opens the file as text rather than by its extension, which macOS reads as video for `.ts` and
 * `.mts`. Linux has no handler that skips the extension, so it has no floor and returns null.
 */
export function textHandlerLaunch(platform: Platform, file: string): Launch | null {
  if (platform === "darwin") return { command: "open", args: ["-t", file] };
  if (platform === "win32") return { command: "notepad.exe", args: [file] };
  return null;
}
