import { open, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** One skill on disk: a `<root>/<name>/SKILL.md` whose frontmatter names and describes it. */
export type Skill = { name: string; description: string; path: string };

/** The directories skills are looked up in, first one wins on a name. */
export type SkillRoots = readonly string[];

const SKILL_FILE = "SKILL.md";
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
/** How much of a SKILL.md is read to find its frontmatter; one that runs longer is read whole. */
const FRONTMATTER_BYTES = 8 * 1024;

/** Where Codex keeps shared skills: the workspace's own first, then the user's. */
export function skillRoots(workspace: { workspaceRoot: string; projectless: boolean }, home = homedir()): SkillRoots {
  const user = path.join(home, ".agents", "skills");
  return workspace.projectless ? [user] : [path.join(workspace.workspaceRoot, ".agents", "skills"), user];
}

/** The frontmatter and body of a SKILL.md; a file without frontmatter is all body. */
export function parseSkillFile(text: string): { fields: Record<string, string>; body: string } {
  const match = FRONTMATTER.exec(text);
  if (!match) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  let key: string | undefined;
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (field) {
      key = field[1]!;
      const value = field[2]!.trim();
      fields[key] = value === ">" || value === "|" ? "" : unquote(value);
    } else if (key !== undefined && /^\s+\S/.test(line)) {
      /** A folded or block scalar continues on indented lines. */
      fields[key] = [fields[key], line.trim()].filter(Boolean).join(" ");
    }
  }
  return { fields, body: text.slice(match[0].length) };
}

function unquote(value: string) {
  return /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
}

/** The head of a file, enough to hold its frontmatter; the whole file when the frontmatter outruns the head. */
async function readHead(file: string) {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(FRONTMATTER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, FRONTMATTER_BYTES, 0);
    const head = buffer.toString("utf8", 0, bytesRead);
    return bytesRead < FRONTMATTER_BYTES || FRONTMATTER.test(head) ? head : await readFile(file, "utf8");
  } finally {
    await handle.close();
  }
}

/** The skill filed in one directory, or nothing where no SKILL.md can be read. */
async function skillIn(root: string, directory: string): Promise<Skill | undefined> {
  const file = path.join(root, directory, SKILL_FILE);
  let head: string;
  try {
    head = await readHead(file);
  } catch {
    return undefined;
  }
  const { fields } = parseSkillFile(head);
  return { name: fields.name || directory, description: fields.description ?? "", path: file };
}

async function skillsIn(root: string): Promise<Skill[]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const found = await Promise.all(entries.sort().map((entry) => skillIn(root, entry)));
  return found.filter((skill): skill is Skill => skill !== undefined);
}

/** Every skill under the roots, one per name: an earlier root's skill hides a later one's. */
export async function listSkills(roots: SkillRoots): Promise<Skill[]> {
  const byName = new Map<string, Skill>();
  for (const skills of await Promise.all(roots.map(skillsIn))) {
    for (const skill of skills) if (!byName.has(skill.name)) byName.set(skill.name, skill);
  }
  return [...byName.values()];
}
