import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test, vi } from "vitest";
import { completeTurn, harness, input, opened } from "../../support/codex-client.mjs";

const execFileAsync = promisify(execFile);

test("a member in its own worktree may commit there, writing only the git folders its repository keeps for it", async () => {
  const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), "aicodingtool-member-")));
  try {
    const project = path.join(scratch, "repo");
    const worktree = path.join(scratch, "repo-1");
    await execFileAsync("git", ["init", "-q", project]);
    await execFileAsync("git", ["-C", project, "-c", "user.name=Tests", "-c", "user.email=tests@example.com", "commit", "-q", "--allow-empty", "-m", "initial"]);
    await execFileAsync("git", ["-C", project, "worktree", "add", "-q", "--detach", worktree]);
    const codex = harness();
    const running = codex.provider.execute(input({ policy: "autonomous", coordinationRole: "member", workspaceRoot: worktree, projectRoot: project }));
    const client = await opened(codex);
    await vi.waitFor(() => assert.equal(client.calls("turn/start").length, 1), { timeout: 5_000 });
    completeTurn(client);
    await running;
    const sandbox = (client.calls("turn/start")[0] as { sandboxPolicy: { writableRoots: string[] } }).sandboxPolicy;
    assert.deepEqual(sandbox.writableRoots, [path.join(project, ".git", "worktrees", "repo-1"), path.join(project, ".git")]);
    codex.provider.closeAll();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
