import assert from "node:assert/strict";
import { test } from "vitest";
import { codexPolicy, sandboxPolicy } from "../../../src/main/codex/codex-policy.mts";

test("every execution policy maps onto Codex approvals, sandbox, and reviewer", () => {
  assert.deepEqual(codexPolicy("confirm"), { approvalPolicy: "untrusted", sandbox: "read-only", approvalsReviewer: "user" });
  assert.deepEqual(codexPolicy("plan"), codexPolicy("confirm"));
  assert.deepEqual(codexPolicy("allow-edits"), { approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "user" });
  assert.deepEqual(codexPolicy("autonomous"), { approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "auto_review" });
  assert.deepEqual(codexPolicy("bypass"), { approvalPolicy: "never", sandbox: "danger-full-access", approvalsReviewer: "user" });
});

test("a run kept out of a checkout gives up the temporary folder that holds it, and only that one", () => {
  const temporary = { slashTmp: ["/tmp", "/private/tmp"], tmpdir: ["/var/folders/xy/T"] };
  const open = { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  const keeping = (projectRoot: string) => ({ projectRoot, gitFolders: [] });
  assert.deepEqual(sandboxPolicy("workspace-write", undefined, temporary), open);
  assert.deepEqual(sandboxPolicy("workspace-write", keeping("/home/me/repo"), temporary), open, "a checkout outside both is not writable to begin with");
  assert.deepEqual(sandboxPolicy("workspace-write", keeping("/private/tmp/qa/repo"), temporary), { ...open, excludeSlashTmp: true });
  assert.deepEqual(sandboxPolicy("workspace-write", keeping("/var/folders/xy/T/repo"), temporary), { ...open, excludeTmpdirEnvVar: true });
  assert.deepEqual(sandboxPolicy("workspace-write", keeping("/tmpfiles/repo"), temporary), open, "a sibling that only shares the name's start is not inside");
  assert.deepEqual(sandboxPolicy("read-only", keeping("/tmp/qa/repo"), temporary), { type: "readOnly", networkAccess: false });
  assert.deepEqual(sandboxPolicy("danger-full-access", keeping("/tmp/qa/repo"), temporary), { type: "dangerFullAccess" });
});

test("a member in a worktree may write the git folders its commits need, and none that reaches the project's files", () => {
  const temporary = { slashTmp: ["/tmp"], tmpdir: [] };
  const own = { projectRoot: "/home/me/repo", gitFolders: ["/home/me/repo/.git/worktrees/repo-1", "/home/me/repo/.git"] };
  const roots = (gitFolders: string[]) => (sandboxPolicy("workspace-write", { ...own, gitFolders }, temporary) as { writableRoots: string[] }).writableRoots;
  assert.deepEqual(roots(own.gitFolders), ["/home/me/repo/.git/worktrees/repo-1", "/home/me/repo/.git"]);
  assert.deepEqual(roots(["/home/me/repo", "/home/me", "/home/me/repo/src/.git", "/home/me/repo/.github"]), [], "the checkout, what holds it, and what sits in its files stay read-only");
  assert.deepEqual(roots(["/srv/git/repo.git"]), ["/srv/git/repo.git"], "a git folder kept apart from the checkout is the repository's, not the project's files");
  assert.deepEqual(sandboxPolicy("read-only", own, temporary), { type: "readOnly", networkAccess: false }, "a read-only run, as a coordinator's is, stays read-only");
  assert.deepEqual(codexPolicy("autonomous", "coordinator").sandbox, "read-only");
});
