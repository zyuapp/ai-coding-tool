/** The terminal command Claudex installs, and the URL it hands a folder back to the app with. */

export const CLI_COMMAND = "claudex";
export const CLI_INSTALL_PATH = "/usr/local/bin/claudex";
export const CLI_URL_SCHEME = "claudex";

/** Stamped into the script so an install can tell its own file from someone else's `claudex`. */
export const CLI_SCRIPT_MARKER = "# claudex-cli v1";

export type CliStatus = {
  /** `conflict` is a different `claudex` already on the path, which an install would overwrite. */
  state: "installed" | "missing" | "conflict" | "unsupported";
  path: string;
};

export const CLI_SCRIPT = [
  "#!/bin/sh",
  CLI_SCRIPT_MARKER,
  "# Opens a folder as a Claudex project. Installed from Claudex settings.",
  "target=$1",
  '[ -n "$target" ] || target=.',
  'if [ ! -d "$target" ]; then',
  `  printf '${CLI_COMMAND}: not a directory: %s\\n' "$target" >&2`,
  "  exit 1",
  "fi",
  'dir=$(cd "$target" && pwd)',
  `encoded=$(printf %s "$dir" | base64 | tr -d '\\n' | tr '+/' '-_')`,
  `exec open "${CLI_URL_SCHEME}://open?path=$encoded"`,
  "",
].join("\n");

export function isCliScript(contents: string) {
  return contents.includes(CLI_SCRIPT_MARKER);
}

/** The folder a `claudex://open?path=` URL names, or null when the URL is not one we wrote. */
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
