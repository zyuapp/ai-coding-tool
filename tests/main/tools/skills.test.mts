import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { listSkills, parseSkillFile, skillRoots } from "../../../src/main/codex/codex-skill-files.mts";

let root: string;

async function skill(dir: string, name: string, file: string) {
  await mkdir(path.join(dir, name), { recursive: true });
  await writeFile(path.join(dir, name, "SKILL.md"), file);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "skills-"));
});

afterEach(() => rm(root, { recursive: true, force: true }));

test("skill roots are the workspace's then the user's Codex skill directories", () => {
  assert.deepEqual(skillRoots({ workspaceRoot: "/code/app", projectless: false }, "/Users/me"), ["/code/app/.agents/skills", "/Users/me/.agents/skills"]);
  assert.deepEqual(skillRoots({ workspaceRoot: "/tmp/none", projectless: true }, "/Users/me"), ["/Users/me/.agents/skills"]);
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

test("a skill whose frontmatter runs past the first read is still named and described", async () => {
  const user = path.join(root, "user");
  const padding = `notes: ${"x".repeat(9_000)}`;
  await skill(user, "long", `---\nname: long\n${padding}\ndescription: Read whole.\n---\nBody.`);
  await skill(user, "big", `---\nname: big\ndescription: Short head.\n---\n${"y".repeat(20_000)}`);
  assert.deepEqual((await listSkills([user])).map(({ name, description }) => ({ name, description })), [
    { name: "big", description: "Short head." },
    { name: "long", description: "Read whole." },
  ]);
});
