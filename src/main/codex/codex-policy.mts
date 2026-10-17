import type { ExecutionPolicy } from "../../domain/run.js";
import type { CoordinationRole } from "../../domain/coordination.js";
import type { ApprovalsReviewer } from "./protocol/v2/ApprovalsReviewer.js";
import type { AskForApproval } from "./protocol/v2/AskForApproval.js";
import type { SandboxPolicy } from "./protocol/v2/SandboxPolicy.js";

type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";

export type CodexPolicy = { approvalPolicy: AskForApproval; sandbox: CodexSandbox; approvalsReviewer: ApprovalsReviewer };

/**
 * Codex has no plan mode, so a plan run is held to what a confirm run may do. A coordinator changes
 * nothing itself: its shell is read-only, and every escalation out of that comes to the app, which
 * refuses it.
 */
export function codexPolicy(policy: ExecutionPolicy, coordinationRole?: CoordinationRole): CodexPolicy {
  const granted = policyGrants(policy);
  return coordinationRole === "coordinator" ? { ...granted, sandbox: "read-only", approvalsReviewer: "user" } : granted;
}

function policyGrants(policy: ExecutionPolicy): CodexPolicy {
  switch (policy) {
    case "confirm":
    case "plan":
      return { approvalPolicy: "untrusted", sandbox: "read-only", approvalsReviewer: "user" };
    case "allow-edits":
      return { approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "user" };
    case "autonomous":
      return { approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "auto_review" };
    case "bypass":
      return { approvalPolicy: "never", sandbox: "danger-full-access", approvalsReviewer: "user" };
  }
}

export const sandboxPolicies: Record<CodexSandbox, SandboxPolicy> = {
  "read-only": { type: "readOnly", networkAccess: false },
  "workspace-write": { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  "danger-full-access": { type: "dangerFullAccess" },
};
