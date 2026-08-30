/** The terminal command AI Coding Tool installs, and the URL it hands a folder back to the app with. */

export const CLI_COMMAND = "aic";
export const CLI_INSTALL_PATH = "/usr/local/bin/aic";
export const CLI_URL_SCHEME = "aicodingtool";

/** Stamped into the script so an install can tell its own file from someone else's `aic`. */
export const CLI_SCRIPT_MARKER = "# aic-cli v1";

export type CliStatus = {
  /** `conflict` is a different `aic` already on the path, which an install would overwrite. */
  state: "installed" | "missing" | "conflict" | "unsupported";
  path: string;
  /** Linux shells can run the installed file by name only when its directory is present here. */
  onPath?: boolean;
};

function cliScript(opener: readonly string[]) {
  return [
    "#!/bin/sh",
    CLI_SCRIPT_MARKER,
    "# Opens a folder as an AI Coding Tool project. Installed from AI Coding Tool settings.",
    "target=$1",
    '[ -n "$target" ] || target=.',
    'if [ ! -d "$target" ]; then',
    `  printf '${CLI_COMMAND}: not a directory: %s\\n' "$target" >&2`,
    "  exit 1",
    "fi",
    'dir=$(cd "$target" && pwd)',
    `encoded=$(printf %s "$dir" | base64 | tr -d '\\n' | tr '+/' '-_')`,
    ...opener,
    "",
  ].join("\n");
}

/** Kept byte-for-byte compatible with existing macOS installs. */
export const CLI_SCRIPT = cliScript([`exec open "${CLI_URL_SCHEME}://open?path=$encoded"`]);

export const LINUX_CLI_SCRIPT = cliScript([
  `url="${CLI_URL_SCHEME}://open?path=$encoded"`,
  'if command -v xdg-open >/dev/null 2>&1; then exec xdg-open "$url"; fi',
  'if command -v gio >/dev/null 2>&1; then exec gio open "$url"; fi',
  `printf '${CLI_COMMAND}: could not find xdg-open or gio to open AI Coding Tool.\\n' >&2`,
  "exit 1",
]);

export type CliConfiguration = { installPath: string; script: string };

/** The per-platform pieces of the terminal integration, kept together for future providers. */
export function cliConfiguration(platform: string, homeDirectory: string): CliConfiguration | null {
  if (platform === "darwin") return { installPath: CLI_INSTALL_PATH, script: CLI_SCRIPT };
  if (platform !== "linux" || !homeDirectory.startsWith("/")) return null;
  const home = homeDirectory.replace(/\/+$/, "") || "/";
  return { installPath: `${home === "/" ? "" : home}/.local/bin/${CLI_COMMAND}`, script: LINUX_CLI_SCRIPT };
}

export function isCliScript(contents: string) {
  return contents.includes(CLI_SCRIPT_MARKER);
}

/** The folder a `aicodingtool://open?path=` URL names, or null when the URL is not one we wrote. */
export function projectPathFromUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== `${CLI_URL_SCHEME}:` || url.hostname !== "open") return null;
  const encoded = url.searchParams.get("path");
  if (!encoded || encoded.length > 8_192 || !/^[A-Za-z0-9\-_=]+$/.test(encoded)) return null;
  let decoded: string;
  try {
    const binary = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
    decoded = new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  } catch {
    return null;
  }
  if (!decoded.startsWith("/") || decoded.includes("\0")) return null;
  return decoded;
}

/** Windows and Linux deliver the URL as a launch argument rather than as an event. */
export function projectPathFromArgv(argv: readonly string[]): string | null {
  for (const argument of argv) {
    if (!argument.startsWith(`${CLI_URL_SCHEME}://`)) continue;
    const root = projectPathFromUrl(argument);
    if (root) return root;
  }
  return null;
}
