import { realpathSync } from "node:fs";
import type { ExecutionPolicy } from "../../domain/run.js";
import type { CoordinationRole } from "../../domain/coordination.js";
import type { ApprovalsReviewer } from "./protocol/v2/ApprovalsReviewer.js";
import type { AskForApproval } from "./protocol/v2/AskForApproval.js";
import type { SandboxPolicy } from "./protocol/v2/SandboxPolicy.js";
import { isPathInside } from "../path-policy.mjs";

type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";

export type CodexPolicy = { approvalPolicy: AskForApproval; sandbox: CodexSandbox; approvalsReviewer: ApprovalsReviewer };

/**
 * Codex puts MCP tool calls to the reviewer and refuses escalations out of the sandbox without asking.
 * Granular has no switch for network review, so a managed network proxy's misses still go to the reviewer.
 */
const TOOL_CALLS_ONLY: AskForApproval = { granular: { sandbox_approval: false, rules: false, skill_approval: false, request_permissions: false, mcp_elicitations: true } };

/**
 * Codex has no plan mode, so a plan run is held to what a confirm run may do. A coordinator changes
 * nothing itself: its shell is read-only, and every escalation out of that comes to the app, which
 * refuses it. In Auto, Codex refuses those itself, so the reviewer that judges every other Auto
 * run's tool calls judges the coordinator's app tools too, as Claude's auto mode does.
 */
export function codexPolicy(policy: ExecutionPolicy, coordinationRole?: CoordinationRole): CodexPolicy {
  const granted = policyGrants(policy);
  if (coordinationRole !== "coordinator") return granted;
  return policy === "autonomous"
    ? { ...granted, approvalPolicy: TOOL_CALLS_ONLY, sandbox: "read-only" }
    : { ...granted, sandbox: "read-only", approvalsReviewer: "user" };
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

const sandboxPolicies: Record<CodexSandbox, SandboxPolicy> = {
  "read-only": { type: "readOnly", networkAccess: false },
  "workspace-write": { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  "danger-full-access": { type: "dangerFullAccess" },
};

/** The temporary folders workspace-write lets every command write in beside its own checkout, each as written and as it really is. */
export type TemporaryFolders = { slashTmp: readonly string[]; tmpdir: readonly string[] };

/**
 * The sandbox a turn runs in. Workspace-write lets a command write in /tmp and $TMPDIR as well as its
 * own checkout, so a run that must leave `kept` alone gives up whichever of them holds it.
 */
export function sandboxPolicy(sandbox: CodexSandbox, kept?: string, temporary: TemporaryFolders = temporaryFolders()): SandboxPolicy {
  const policy = sandboxPolicies[sandbox];
  if (policy.type !== "workspaceWrite" || !kept) return policy;
  const holdsKept = (folders: readonly string[]) => folders.some((folder) => isPathInside(folder, kept));
  return { ...policy, excludeSlashTmp: holdsKept(temporary.slashTmp), excludeTmpdirEnvVar: holdsKept(temporary.tmpdir) };
}

/** A checkout's root is kept resolved, and /tmp is /private/tmp on macOS, so each folder is matched both ways. */
function temporaryFolders(environment: NodeJS.ProcessEnv = process.env): TemporaryFolders {
  return { slashTmp: bothWays("/tmp"), tmpdir: environment.TMPDIR ? bothWays(environment.TMPDIR) : [] };
}

function bothWays(folder: string) {
  try {
    return [folder, realpathSync(folder)];
  } catch {
    return [folder];
  }
}
