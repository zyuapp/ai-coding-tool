import type { CoordinationRole } from "../../domain/coordination.js";
import type { BoundTool } from "./tool-definition.mjs";

/** The few words an engine needs said its own way. */
export type BriefDialect = {
  /** The engine's own sessions and helpers, which an app thread ID never names. */
  nativeWork: string;
  /** The engine's own way to make a worktree, which the app would never hear about. */
  nativeWorktree?: string;
  /** How a coordinator reads on this engine, said so it is told only of tools it really has. */
  coordinatorReads: string;
  /** How a member in a checkout of its own commits there, for an engine whose sandbox keeps it from doing so as it does everything else. */
  ownCheckoutCommits?: string;
};

/** What a server's brief may read of the run besides what it was offered. */
export type BriefRun = { coordinationRole?: CoordinationRole | undefined; workspaceRoot: string; projectRoot?: string | undefined };

/** Whether the run is offered the server at all, or, given a name, that tool of it. */
export type Offers = (tool?: string) => boolean;

/**
 * One of the app's MCP servers, described once so every engine serves, grants and briefs it alike.
 * `Run` is what of the run the server binds to.
 */
export type ToolServer<Run> = {
  name: string;
  /** Every tool the server can offer, whichever of them a run is given. */
  definitions: readonly { name: string; readOnly: boolean }[];
  /** Which of its tools run without approval: every tool filed under it, only its read-only ones, or none. */
  grants: "all" | "read-only" | "none";
  /** The tools a run is given, before its channel withholds any, or undefined when it is not offered the server. */
  serve: (run: Run) => BoundTool[] | undefined;
  /** What the run is told, read from what its channel left it. */
  brief?: (offers: Offers, dialect: BriefDialect, run: BriefRun) => string[];
};
