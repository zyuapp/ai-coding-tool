/** The terminal command AI Coding Tool installs, and the URL it hands a folder back to the app with. */

export const CLI_COMMAND = "aic";
export const CLI_INSTALL_PATH = "/usr/local/bin/aic";
export const CLI_URL_SCHEME = "aicodingtool";

/** Stamped into the script so an install can tell its own file from someone else's `aic`. Older stamps still count as ours. */
export const CLI_SCRIPT_MARKER = "# aic-cli v2";
const CLI_SCRIPT_STAMP = "# aic-cli v";

export type CliStatus = {
  /** `conflict` is a different `aic` already on the path, which an install would overwrite. */
  state: "installed" | "missing" | "conflict" | "unsupported";
  path: string;
  /** Linux shells can run the installed file by name only when its directory is present here. */
  onPath?: boolean;
  /** Whether an installed script is the one this build writes. An older one still opens folders, but cannot serve. */
  current?: boolean;
};

/**
 * Runs the app's own Node against the headless entry inside its package, on either platform's
 * layout. The script has no way to name a file inside an AppImage, so the binary finds it itself.
 */
/** Run by the app binary as Node: finds the packaged serve entry beside it and starts it as the command. */
export const SERVE_BOOTSTRAP = '(function(){var p=require("path"),f=require("fs"),d=p.dirname(process.execPath);var c=[p.join(d,"resources"),p.join(d,"..","Resources")];for(var i=0;i<c.length;i++){var s=p.join(c[i],"app.asar","dist","main","main","serve.js");if(f.existsSync(s))return require(s).cli()}console.error("aic: could not find AI Coding Tool beside "+process.execPath);process.exit(1)})()';

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** What `aic serve` and `aic pair` run: the app itself as Node, or a refusal from an install that knows no app. */
function serveLines(executable: string | null) {
  if (!executable) return [`    printf '${CLI_COMMAND}: this install cannot serve. Install the command again from AI Coding Tool.\\n' >&2`, "    exit 1"];
  return [`    exec env ELECTRON_RUN_AS_NODE=1 ${shellQuote(executable)} -e ${shellQuote(SERVE_BOOTSTRAP)} -- "$@"`];
}

function cliScript(opener: readonly string[], executable: string | null) {
  return [
    "#!/bin/sh",
    CLI_SCRIPT_MARKER,
    "# Opens a folder as an AI Coding Tool project, or serves the app headless. Installed from AI Coding Tool settings.",
    'case "$1" in',
    "  serve|pair)",
    ...serveLines(executable),
    "    ;;",
    "esac",
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

export const macCliScript = (executable: string | null) => cliScript([`exec open "${CLI_URL_SCHEME}://open?path=$encoded"`], executable);

export const linuxCliScript = (executable: string | null) => cliScript([
  `url="${CLI_URL_SCHEME}://open?path=$encoded"`,
  // Generic xdg-open can misread quoted desktop Exec paths and fall back to a browser.
  'if command -v gio >/dev/null 2>&1; then exec gio open "$url"; fi',
  'if command -v xdg-open >/dev/null 2>&1; then exec xdg-open "$url"; fi',
  `printf '${CLI_COMMAND}: could not find xdg-open or gio to open AI Coding Tool.\\n' >&2`,
  "exit 1",
], executable);

export type CliConfiguration = { installPath: string; script: string };

/**
 * The per-platform pieces of the terminal integration, kept together for future providers. The
 * executable is the app as installed on this machine, which `aic serve` runs as Node; an install
 * that knows none, such as one written from a source checkout, refuses to serve.
 */
export function cliConfiguration(platform: string, homeDirectory: string, executable: string | null = null): CliConfiguration | null {
  if (platform === "darwin") return { installPath: CLI_INSTALL_PATH, script: macCliScript(executable) };
  if (platform !== "linux" || !homeDirectory.startsWith("/")) return null;
  const home = homeDirectory.replace(/\/+$/, "") || "/";
  return { installPath: `${home === "/" ? "" : home}/.local/bin/${CLI_COMMAND}`, script: linuxCliScript(executable) };
}

export function isCliScript(contents: string) {
  return contents.includes(CLI_SCRIPT_STAMP);
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
