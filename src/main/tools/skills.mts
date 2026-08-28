import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { bindTools, defineTool, type ToolDefinition } from "./tool-definition.mjs";

/** One skill on disk: a `<root>/<name>/SKILL.md` whose frontmatter names and describes it. */
export type Skill = { name: string; description: string; path: string };

/** The directories skills are looked up in, first one wins on a name. */
export type SkillRoots = readonly string[];

const SKILL_FILE = "SKILL.md";

/**
 * Where the user keeps skills in Claude's layout: the workspace's own first, then the user's,
 * which honours `CLAUDE_CONFIG_DIR` the way Claude does.
 */
export function skillRoots(workspace: { workspaceRoot: string; projectless: boolean }, env: NodeJS.ProcessEnv = process.env, home = homedir()): SkillRoots {
  const user = path.join(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "skills");
  return workspace.projectless ? [user] : [path.join(workspace.workspaceRoot, ".claude", "skills"), user];
}

/** The frontmatter and body of a SKILL.md; a file without frontmatter is all body. */
export function parseSkillFile(text: string): { fields: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
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

async function skillsIn(root: string): Promise<Skill[]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const found = await Promise.all(entries.sort().map(async (entry): Promise<Skill | undefined> => {
    const file = path.join(root, entry, SKILL_FILE);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return undefined;
    }
    const { fields } = parseSkillFile(text);
    return { name: fields.name || entry, description: fields.description ?? "", path: file };
  }));
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

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

/** Read-only both: they only ever look at SKILL.md files the user wrote. */
export const SKILL_TOOLS: readonly ToolDefinition<SkillRoots>[] = [
  defineTool({
    name: "skills_list",
    description: "List the user's skills: reusable instructions for particular kinds of task, each named with what it covers. Read one with skill_read before doing a task it covers.",
    input: {},
    readOnly: true,
    run: async (roots) => {
      const skills = await listSkills(roots);
      if (!skills.length) return text("The user has no skills.");
      return text(skills.map((skill) => `${skill.name}: ${skill.description || "(no description)"}`).join("\n"));
    },
  }),
  defineTool({
    name: "skill_read",
    description: "Read one skill's instructions in full. Follow them for the task at hand; paths inside are relative to the skill's directory.",
    input: { name: z.string().min(1).describe("The skill's name, as skills_list reports it.") },
    readOnly: true,
    run: async (roots, args) => {
      const skill = (await listSkills(roots)).find((candidate) => candidate.name === args.name);
      if (!skill) return { ...text(`No skill is named "${args.name}". Call skills_list to see the names.`), isError: true };
      const { body } = parseSkillFile(await readFile(skill.path, "utf8"));
      return text(`Skill directory: ${path.dirname(skill.path)}\n\n${body.trim()}`);
    },
  }),
];

export function skillTools(roots: SkillRoots) {
  return bindTools(roots, SKILL_TOOLS);
}
