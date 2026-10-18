import assert from "node:assert/strict";
import { test } from "vitest";
import type { ProviderRunInput } from "../../../src/main/agent/agent-provider.mts";
import type { ToolIntent } from "../../../src/domain/run.ts";
import { codexPolicy, sandboxPolicy } from "../../../src/main/codex/codex-policy.mts";
import { completeTurn, harness, input, opened, sentBy } from "../../support/codex-client.mjs";

/**
 * A member in a worktree of its own keeps its git data in the project's `.git`, which its sandbox
 * never opens, so its commit asks to run outside the sandbox, and that request is decided like any.
 */

const at = { threadId: "thread-1", turnId: "turn-1" };
const commit = { kind: "command" as const, ...at, itemId: "commit-1", startedAtMs: 1, environmentId: null, command: "git commit -m 'Rename the flag'", cwd: "/worktrees/repo-1", reason: "Writing the worktree's git data needs to run outside the sandbox." };
const ownCheckout = { coordinationRole: "member" as const, workspaceRoot: "/worktrees/repo-1", projectRoot: "/repo" };

async function asking(overrides: Partial<ProviderRunInput>, answer: "allow" | "deny" = "allow") {
  const asked: ToolIntent[] = [];
  const codex = harness();
  const running = codex.provider.execute(input({ ...overrides, authorize: async (intent) => { asked.push(intent); return answer; } }));
  const client = await opened(codex);
  await sentBy(client, "turn/start");
  const reply = await client.ask("item/commandExecution/requestApproval", commit);
  completeTurn(client);
  await running;
  codex.provider.closeAll();
  return { reply, asked, sandbox: (client.calls("turn/start")[0] as { sandboxPolicy: unknown }).sandboxPolicy };
}

test("a member's commit from its own worktree is put to its user, and runs on their word", async () => {
  for (const policy of ["confirm", "plan", "allow-edits"] as const) {
    const allowed = await asking({ ...ownCheckout, policy });
    assert.deepEqual(allowed.reply, { result: { decision: "accept" } }, `${policy}: the user allowed it`);
    assert.deepEqual(allowed.asked.map((intent) => intent.input), [{ command: commit.command, cwd: commit.cwd, reason: commit.reason }], `${policy}: the user is asked`);
    const refused = await asking({ ...ownCheckout, policy }, "deny");
    assert.deepEqual(refused.reply, { result: { decision: "decline" } }, `${policy}: and refused only by them`);
  }
  const bypass = await asking({ ...ownCheckout, policy: "bypass" }, "deny");
  assert.deepEqual(bypass.reply, { result: { decision: "accept" } }, "a bypass run needs nobody's word");
  assert.deepEqual(codexPolicy("autonomous", "member"), { approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "auto_review" }, "in Auto, Codex's own reviewer decides it");
});

test("a member's sandbox never opens the project's git data, whose config could run anything outside it", async () => {
  const { sandbox } = await asking({ ...ownCheckout, policy: "allow-edits" });
  assert.deepEqual((sandbox as { writableRoots: unknown }).writableRoots, []);
  assert.deepEqual(sandboxPolicy("workspace-write", "/repo", { slashTmp: ["/tmp"], tmpdir: [] }), { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false });
});

test("a coordinator's request to run outside its read-only shell is refused without asking anyone", async () => {
  for (const policy of ["confirm", "allow-edits", "autonomous"] as const) {
    const refused = await asking({ coordinationRole: "coordinator", policy });
    assert.deepEqual(refused.reply, { result: { decision: "decline" } }, policy);
    assert.deepEqual(refused.asked, [], `${policy}: nobody is asked`);
  }
});
