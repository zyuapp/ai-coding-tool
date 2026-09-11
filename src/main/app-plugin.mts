import path from "node:path";

/** The plugin name both engines qualify the app's skills with. */
export const APP_PLUGIN_NAME = "aicodingtool";

let root: string | undefined;

/** Where the app's own plugin lives on disk, set once by the main process. Unset means no app skills. */
export function setAppPluginRoot(directory: string | undefined) {
  root = directory;
}

export function appPluginRoot() {
  return root;
}

/** The plugin's skills folder, which Codex reads as an extra skill root. */
export function appSkillsRoot() {
  return root === undefined ? undefined : path.join(root, "skills");
}

/** `aicodingtool:review-thread` and `review-thread` are the same app skill. */
export function unqualifiedSkillName(name: string) {
  const prefix = `${APP_PLUGIN_NAME}:`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}
