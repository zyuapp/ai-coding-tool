import { reduceThreadCommands, THREAD_COMMAND_INPUTS } from "./thread-commands.js";
import { reduceWorktrees, WORKTREE_INPUTS } from "./worktrees.js";
import { COORDINATION_INPUTS, reduceCoordination } from "./coordination.js";
import { PROPOSAL_INPUTS, reduceProposals } from "./proposals.js";
import { reduceWorktreeMenu, WORKTREE_MENU_INPUTS } from "./worktree-menu.js";
import { reduceSending, SEND_INPUTS } from "./sending.js";
import { ATTACHMENT_INPUTS, reduceComposerAttachments } from "./composer-attachments.js";
import { PROJECT_ADD_INPUTS, reduceProjectAdd } from "../project-add.js";
import { PROJECT_INPUTS, reduceProjectCommands } from "./projects.js";
import { CLI_INPUTS, reduceCli } from "./cli.js";
import { COMPUTER_USE_INPUTS, reduceComputerUse } from "./computer-use.js";
import { PLAN_USAGE_INPUTS, reducePlanUsage } from "./plan-usage.js";
import { PULL_REQUEST_INPUTS, reducePullRequests } from "./pull-requests.js";
import { reduceRuns, RUN_INPUTS } from "./runs.js";
import { AUTOMATION_INPUTS, reduceAutomations } from "./automations.js";
import { reduceSideChats, SIDE_CHAT_INPUTS } from "./side-chats.js";
import { DIFF_INPUTS, reduceDiffs } from "./diffs.js";
import { reduceStore, STORE_INPUTS } from "./store.js";
import { COMPOSER_INPUTS, reduceComposer } from "./composer.js";
import { reduceSettings, reduceModelFavorite, SETTINGS_INPUTS } from "./settings.js";
import { DOCK_INPUTS, reduceDock } from "./dock.js";
import { BROWSER_INPUTS, reduceBrowser } from "./browser.js";
import { BROWSER_IMPORT_INPUTS, reduceBrowserImport } from "./browser-import.js";
import { DESKTOP_INPUTS, reduceDesktop } from "./desktop.js";
import { reduceView, VIEW_INPUTS } from "./view.js";
import type { WorkspaceInput, WorkspaceTransition } from "./types.js";
import { isRemoteInput, reduceRemote, type RemoteInput } from "../remote-commands.js";
import { isComputerInput, reduceComputers, type ComputerInput } from "../computer-commands.js";
import { isEngineInput, reduceEngine, type EngineInput } from "../engine-access.js";
import { reduceToasts } from "../toasts.js";
import type { WorkspaceState } from "../workspace-state.js";
import { cancelPause, resumeThread } from "../limit-pauses.js";
import { settled } from "./shared.js";
import { APP_UPDATE_INPUTS, reduceAppUpdate } from "../app-updates.js";

type Reducer<Type extends WorkspaceInput["type"]> = (state: WorkspaceState, input: Extract<WorkspaceInput, { type: Type }>) => WorkspaceTransition;

/** The input types one reducer answers, as that reducer lists them. */
type Claim<Type extends WorkspaceInput["type"]> = { types: readonly Type[]; reducer: Reducer<Type> };

function claim<Type extends WorkspaceInput["type"]>(types: readonly Type[], reducer: Reducer<NoInfer<Type>>): Claim<Type> {
  return { types, reducer };
}

/** Each input type is claimed by exactly one reducer. */
export const CLAIMS = [
  claim(WORKTREE_MENU_INPUTS, reduceWorktreeMenu),
  claim(THREAD_COMMAND_INPUTS, reduceThreadCommands),
  claim(COORDINATION_INPUTS, reduceCoordination),
  claim(PROPOSAL_INPUTS, reduceProposals),
  claim(WORKTREE_INPUTS, reduceWorktrees),
  claim(ATTACHMENT_INPUTS, reduceComposerAttachments),
  claim(SEND_INPUTS, reduceSending),
  claim(PROJECT_ADD_INPUTS, reduceProjectAdd),
  claim(PROJECT_INPUTS, reduceProjectCommands),
  /** The line itself moves in {@link reconcileLimitPauses}, which every input passes through. */
  claim(["limits.elapsed"], (state) => settled(state)),
  claim(["limit.resume"], (state, input) => resumeThread(state, input.taskId)),
  claim(["limit.cancel"], (state, input) => cancelPause(state, input.taskId)),
  claim(RUN_INPUTS, reduceRuns),
  claim(AUTOMATION_INPUTS, reduceAutomations),
  claim(SIDE_CHAT_INPUTS, reduceSideChats),
  claim(PULL_REQUEST_INPUTS, reducePullRequests),
  claim(COMPUTER_USE_INPUTS, reduceComputerUse),
  claim(PLAN_USAGE_INPUTS, reducePlanUsage),
  claim(CLI_INPUTS, reduceCli),
  claim(DIFF_INPUTS, reduceDiffs),
  claim(STORE_INPUTS, reduceStore),
  claim(COMPOSER_INPUTS, reduceComposer),
  claim(["view.set-model-favorite"], reduceModelFavorite),
  claim(["view.dismiss-toast"], reduceToasts),
  claim(APP_UPDATE_INPUTS, reduceAppUpdate),
  claim(SETTINGS_INPUTS, reduceSettings),
  claim(DOCK_INPUTS, reduceDock),
  claim(BROWSER_INPUTS, reduceBrowser),
  claim(BROWSER_IMPORT_INPUTS, reduceBrowserImport),
  claim(DESKTOP_INPUTS, reduceDesktop),
  claim(VIEW_INPUTS, reduceView),
];

type ClaimedInput = Extract<WorkspaceInput, { type: (typeof CLAIMS)[number]["types"][number] }>;
type ClaimedReducer = (state: WorkspaceState, input: ClaimedInput) => WorkspaceTransition;

const REDUCERS = new Map<string, ClaimedReducer>(CLAIMS.flatMap(({ types, reducer }) => types.map((type) => [type, reducer as ClaimedReducer] as const)));

/**
 * Every input {@link reduce} has not already unpacked into the several inputs it stands for. An input
 * no reducer claims is not a type this accepts, so the compiler names it where {@link reduce} calls here.
 */
export function apply(state: WorkspaceState, input: RemoteInput | ComputerInput | EngineInput | ClaimedInput): WorkspaceTransition {
  if (isRemoteInput(input)) return reduceRemote(state, input);
  if (isComputerInput(input)) return reduceComputers(state, input);
  if (isEngineInput(input)) return reduceEngine(state, input);
  return REDUCERS.get(input.type)!(state, input);
}
