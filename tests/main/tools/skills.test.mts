import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { listSkills, parseSkillFile, skillRoots, skillTools } from "../../../src/main/tools/skills.mts";

let root: string;

async function skill(dir: string, name: string, file: string) {
  await mkdir(path.join(dir, name), { recursive: true });
  await writeFile(path.join(dir, name, "SKILL.md"), file);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "skills-"));
});

afterEach(() => rm(root, { recursive: true, force: true }));

test("skill roots are the workspace's then the user's, and the user's follows CLAUDE_CONFIG_DIR", () => {
  assert.deepEqual(skillRoots({ workspaceRoot: "/code/app", projectless: false }, {}, "/Users/me"), ["/code/app/.claude/skills", "/Users/me/.claude/skills"]);
  assert.deepEqual(skillRoots({ workspaceRoot: "/tmp/none", projectless: true }, { CLAUDE_CONFIG_DIR: "/cfg" }, "/Users/me"), ["/cfg/skills"]);
});

test("frontmatter names and describes a skill, folded values included, and the body is what follows it", () => {
  const parsed = parseSkillFile("---\nname: docx\ndescription: >\n  Make Word\n  documents.\nallowed-tools: \"Bash\"\n---\n# Docx\n\nSteps.\n");
  assert.deepEqual(parsed.fields, { name: "docx", description: "Make Word documents.", "allowed-tools": "Bash" });
  assert.equal(parsed.body, "# Docx\n\nSteps.\n");
  assert.deepEqual(parseSkillFile("Just text"), { fields: {}, body: "Just text" });
});

test("skills are listed from every root, the workspace's hiding the user's of the same name", async () => {
  const user = path.join(root, "user");
  const workspace = path.join(root, "workspace");
  await skill(user, "unslop", "---\nname: unslop\ndescription: Cut AI tells.\n---\nBody.");
  await skill(user, "docx", "---\nname: docx\ndescription: User docx.\n---\n");
  await skill(user, "unnamed", "No frontmatter here.");
  await mkdir(path.join(user, "empty"));
  await writeFile(path.join(user, "stray.md"), "");
  await skill(workspace, "docx", "---\nname: docx\ndescription: Project docx.\n---\nProject body.");

  const skills = await listSkills([workspace, user, path.join(root, "missing")]);
  assert.deepEqual(skills.map(({ name, description }) => ({ name, description })), [
    { name: "docx", description: "Project docx." },
    { name: "unnamed", description: "" },
    { name: "unslop", description: "Cut AI tells." },
  ]);
  assert.equal(skills[0]!.path, path.join(workspace, "docx", "SKILL.md"));
});

test("skills_list names each skill and skill_read gives its directory and body", async () => {
  const user = path.join(root, "user");
  await skill(user, "unslop", "---\nname: unslop\ndescription: Cut AI tells.\n---\n# Unslop\n\nEdit text.\n");
  const tools = skillTools([user]);
  const list = tools.find((tool) => tool.name === "skills_list")!;
  const read = tools.find((tool) => tool.name === "skill_read")!;

  assert.equal((await list.handler({})).content[0]!.text, "unslop: Cut AI tells.");
  const body = await read.handler({ name: "unslop" });
  assert.equal(body.content[0]!.text, `Skill directory: ${path.join(user, "unslop")}\n\n# Unslop\n\nEdit text.`);
  const missing = await read.handler({ name: "nope" });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0]!.text, /No skill is named "nope"/);

  await skill(user, "later", "---\nname: later\ndescription: Added after the first call.\n---\n");
  assert.match((await list.handler({})).content[0]!.text, /later: Added after/, "each call reads the directory afresh");
  assert.equal((await skillTools([path.join(root, "none")]).find((tool) => tool.name === "skills_list")!.handler({})).content[0]!.text, "The user has no skills.");
});
