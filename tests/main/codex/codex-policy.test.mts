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
  assert.deepEqual(sandboxPolicy("workspace-write", undefined, temporary), open);
  assert.deepEqual(sandboxPolicy("workspace-write", "/home/me/repo", temporary), open, "a checkout outside both is not writable to begin with");
  assert.deepEqual(sandboxPolicy("workspace-write", "/private/tmp/qa/repo", temporary), { ...open, excludeSlashTmp: true });
  assert.deepEqual(sandboxPolicy("workspace-write", "/var/folders/xy/T/repo", temporary), { ...open, excludeTmpdirEnvVar: true });
  assert.deepEqual(sandboxPolicy("workspace-write", "/tmpfiles/repo", temporary), open, "a sibling that only shares the name's start is not inside");
  assert.deepEqual(sandboxPolicy("read-only", "/tmp/qa/repo", temporary), { type: "readOnly", networkAccess: false });
  assert.deepEqual(sandboxPolicy("danger-full-access", "/tmp/qa/repo", temporary), { type: "dangerFullAccess" });
});
