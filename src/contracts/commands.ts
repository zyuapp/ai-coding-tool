import type { ExternalAppCommand } from "./app-commands.js";
import type { AnnotationCommand, FileCommand, ImageCommand, ImageViewCommand, PasteCommand } from "./attachment-commands.js";
import type { AutomationCommand } from "./automation-commands.js";
import type { BrowserCommand, BrowserImportCommand } from "./browser-commands.js";
import type { CliCommand } from "./cli-commands.js";
import type { ComputerCommand } from "./computer-commands.js";
import type { ComputerUseAccessCommand } from "./computer-use-commands.js";
import type { DictationCommand } from "./dictation-commands.js";
import type { DiffCommand } from "./diff-commands.js";
import type { EngineCommand } from "./engine-commands.js";
import type { ProjectCommand } from "./project-commands.js";
import type { PullRequestCommand } from "./pull-request-commands.js";
import type { RemoteCommand } from "./remote-commands.js";
import type { ReviewCommand, RunControlCommand } from "./run-commands.js";
import type { SideChatCommand, TaskCommand } from "./task-commands.js";
import type { SimulatorCommand } from "./simulator-commands.js";
import type { TerminalCommand } from "./terminal-commands.js";
import type { PlanUsageCommand } from "./usage-commands.js";
import type { ViewCommand } from "./view-commands.js";
import type { WorktreeCommand } from "./worktree-commands.js";

export type { ExternalAppCommand, AnnotationCommand, FileCommand, ImageCommand, ImageViewCommand, PasteCommand, AutomationCommand, BrowserCommand, BrowserImportCommand, CliCommand, ComputerCommand, ComputerUseAccessCommand, DictationCommand, DiffCommand, EngineCommand, ProjectCommand, PullRequestCommand, RemoteCommand, ReviewCommand, RunControlCommand, SideChatCommand, TaskCommand, SimulatorCommand, TerminalCommand, PlanUsageCommand, ViewCommand, WorktreeCommand };
export type { TaskDropTarget } from "./task-commands.js";
export type { ReadingPoint } from "./view-commands.js";

/**
 * Every interaction the application supports, named as data. The UI dispatches these instead of
 * mutating state, so any other caller — a tool, a script, a test — can drive the same behaviour
 * through the same door. Anything that reaches {@link AppCommand} from outside the window has to be
 * validated at that boundary first, the way `isRunCommand` guards the run channel.
 *
 * Each feature declares its commands, and the table that validates them, in its own `*-commands.ts`.
 */
export type AppCommand = TaskCommand | AnnotationCommand | PasteCommand | ImageCommand | ImageViewCommand | CliCommand | ComputerUseAccessCommand | PlanUsageCommand | ProjectCommand | PullRequestCommand | RunControlCommand | ReviewCommand | WorktreeCommand | SideChatCommand | AutomationCommand | BrowserCommand | BrowserImportCommand | SimulatorCommand | DictationCommand | DiffCommand | FileCommand | ExternalAppCommand | TerminalCommand | RemoteCommand | ComputerCommand | EngineCommand | ViewCommand;
