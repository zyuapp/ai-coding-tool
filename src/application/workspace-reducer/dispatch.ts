import { reduceThreadCommands, THREAD_COMMAND_INPUTS } from "./thread-commands.js";
import { reduceWorktreeManagement, reduceWorktrees, WORKTREE_INPUTS, WORKTREE_MANAGEMENT_INPUTS } from "./worktrees.js";
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
import { reduceRunControl, reduceRunUnresolved, reduceRuns, RUN_CONTROL_INPUTS, RUN_INPUTS } from "./runs.js";
import { AUTOMATION_INPUTS, reduceAutomations } from "./automations.js";
import { reduceSideChats, SIDE_CHAT_INPUTS } from "./side-chats.js";
import { DIFF_INPUTS, reduceDiffs } from "./diffs.js";
import { reduceHiddenThreadsDismissed, reduceStore, STORE_INPUTS } from "./store.js";
import { reduceStoreLoad, STORE_LOAD_INPUTS } from "../workspace-load.js";
import { COMPOSER_INPUTS, reduceComposer } from "./composer.js";
import { reduceSettings, reduceModelFavorite, reduceRememberProject, SETTINGS_INPUTS } from "./settings.js";
import { DOCK_INPUTS, reduceDock } from "./dock.js";
import { BROWSER_INPUTS, reduceBrowser } from "./browser.js";
import { BROWSER_IMPORT_INPUTS, reduceBrowserImport } from "./browser-import.js";
import { reduceSimulator, SIMULATOR_INPUTS } from "./simulator.js";
import { DICTATION_INPUTS, reduceDictation } from "./dictation.js";
import { DESKTOP_INPUTS, reduceDesktop } from "./desktop.js";
import { reduceTerminal, TERMINAL_INPUTS } from "./terminal.js";
import { reduceView, VIEW_INPUTS } from "./view.js";
import type { WorkspaceInput, WorkspaceTransition } from "./types.js";
import { isRemoteInput, reduceRemote, type RemoteInput } from "../remote-commands.js";
import { isComputerInput, reduceComputers, type ComputerInput } from "../computer-commands.js";
import { isEngineInput, reduceEngine, type EngineInput } from "../engine-access.js";
import { reduceToasts } from "../toasts.js";
import type { SliceState, WorkspaceState } from "../workspace-state.js";
import { pauseCancelled, resumed } from "../limit-pauses.js";
import { reduceErrorDismissed } from "./shared.js";
import { owned, type SliceTransition } from "./slice.js";
import { APP_UPDATE_INPUTS, reduceAppUpdate } from "../app-updates.js";

type Input<Type extends WorkspaceInput["type"]> = Extract<WorkspaceInput, { type: Type }>;
type Reducer<Type extends WorkspaceInput["type"]> = (state: WorkspaceState, input: Input<Type>) => WorkspaceTransition;

/** The input types one reducer answers, as that reducer lists them. */
type Claim<Type extends WorkspaceInput["type"]> = { types: readonly Type[]; reducer: Reducer<Type> };

/** Nothing when every field `Own` names is one slice's; otherwise an argument no call can give. */
type OneSlice<Own> = true extends (SliceState extends infer Slice ? Slice extends unknown ? keyof Own extends keyof Slice ? true : never : never : never) ? [] : [never];

/**
 * A feature: its reducer changes only fields of one slice's state and reaches every other owner
 * through that owner's edits. A reducer that hands back a whole state, or names fields of more than
 * one slice, does not compile here.
 */
function feature<In, Own, Facet>(reducer: (state: WorkspaceState, input: In) => SliceTransition<Own, Facet>, ..._oneSlice: OneSlice<Own>): (state: WorkspaceState, input: In) => WorkspaceTransition {
  return owned(reducer);
}

function claim<Type extends WorkspaceInput["type"], Own, Facet>(types: readonly Type[], reducer: (state: WorkspaceState, input: Input<NoInfer<Type>>) => SliceTransition<Own, Facet>, ..._oneSlice: OneSlice<Own>): Claim<Type> {
  return { types, reducer: owned(reducer) };
}

/** Composition: a pass that fills in or reconciles every owner's state at once, which no feature is. */
function composition<Type extends WorkspaceInput["type"]>(types: readonly Type[], reducer: Reducer<NoInfer<Type>>): Claim<Type> {
  return { types, reducer };
}

/** A feature whose reducer still changes the whole state, until its changes are split into its owners' edits. */
function unowned<Type extends WorkspaceInput["type"]>(types: readonly Type[], reducer: Reducer<NoInfer<Type>>): Claim<Type> {
  return { types, reducer };
}

/** Each input type is claimed by exactly one reducer. */
export const CLAIMS = [
  claim(WORKTREE_MENU_INPUTS, reduceWorktreeMenu),
  claim(THREAD_COMMAND_INPUTS, reduceThreadCommands),
  claim(COORDINATION_INPUTS, reduceCoordination),
  claim(PROPOSAL_INPUTS, reduceProposals),
  claim(WORKTREE_INPUTS, reduceWorktrees),
  claim(WORKTREE_MANAGEMENT_INPUTS, reduceWorktreeManagement),
  claim(ATTACHMENT_INPUTS, reduceComposerAttachments),
  claim(SEND_INPUTS, reduceSending),
  claim(PROJECT_ADD_INPUTS, reduceProjectAdd),
  claim(PROJECT_INPUTS, reduceProjectCommands),
  /** The line itself moves in {@link reconcileLimitPauses}, which every input passes through. */
  claim(["limits.elapsed"], () => ({})),
  claim(["limit.resume"], (state, input) => resumed(state, input.taskId)),
  claim(["limit.cancel"], (state, input) => pauseCancelled(state, input.taskId)),
  claim(["run.unresolved"], reduceRunUnresolved),
  unowned(RUN_INPUTS, reduceRuns),
  claim(RUN_CONTROL_INPUTS, reduceRunControl),
  claim(AUTOMATION_INPUTS, reduceAutomations),
  claim(SIDE_CHAT_INPUTS, reduceSideChats),
  claim(PULL_REQUEST_INPUTS, reducePullRequests),
  claim(COMPUTER_USE_INPUTS, reduceComputerUse),
  claim(PLAN_USAGE_INPUTS, reducePlanUsage),
  claim(CLI_INPUTS, reduceCli),
  claim(DIFF_INPUTS, reduceDiffs),
  claim(STORE_INPUTS, reduceStore),
  composition(STORE_LOAD_INPUTS, reduceStoreLoad),
  claim(COMPOSER_INPUTS, reduceComposer),
  claim(["view.dismiss-action-error"], reduceErrorDismissed),
  claim(["view.dismiss-hidden-tasks"], reduceHiddenThreadsDismissed),
  claim(["view.set-model-favorite"], reduceModelFavorite),
  claim(["view.remember-project"], reduceRememberProject),
  claim(["view.dismiss-toast", "view.hold-toasts"], reduceToasts),
  claim(APP_UPDATE_INPUTS, reduceAppUpdate),
  claim(SETTINGS_INPUTS, reduceSettings),
  claim(DOCK_INPUTS, reduceDock),
  claim(BROWSER_INPUTS, reduceBrowser),
  claim(BROWSER_IMPORT_INPUTS, reduceBrowserImport),
  claim(SIMULATOR_INPUTS, reduceSimulator),
  claim(DICTATION_INPUTS, reduceDictation),
  claim(DESKTOP_INPUTS, reduceDesktop),
  claim(TERMINAL_INPUTS, reduceTerminal),
  claim(VIEW_INPUTS, reduceView),
];

type ClaimedInput = Extract<WorkspaceInput, { type: (typeof CLAIMS)[number]["types"][number] }>;
type ClaimedReducer = (state: WorkspaceState, input: ClaimedInput) => WorkspaceTransition;

const remote = feature(reduceRemote);
const engine = feature(reduceEngine);
const computers = feature(reduceComputers);

const REDUCERS = new Map<string, ClaimedReducer>(CLAIMS.flatMap(({ types, reducer }) => types.map((type) => [type, reducer as ClaimedReducer] as const)));

/**
 * Every input {@link reduce} has not already unpacked into the several inputs it stands for. An input
 * no reducer claims is not a type this accepts, so the compiler names it where {@link reduce} calls here.
 */
export function apply(state: WorkspaceState, input: RemoteInput | ComputerInput | EngineInput | ClaimedInput): WorkspaceTransition {
  if (isRemoteInput(input)) return remote(state, input);
  if (isComputerInput(input)) return computers(state, input);
  if (isEngineInput(input)) return engine(state, input);
  return REDUCERS.get(input.type)!(state, input);
}
