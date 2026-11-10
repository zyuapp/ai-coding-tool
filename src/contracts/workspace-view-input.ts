import type { AppCommand } from "./commands.js";
import type { ExternalCommand } from "./threads.js";
import { isSettingsSection, type SettingsSection } from "../domain/settings-section.js";
import type { FindResults, FindTarget } from "../domain/find.js";
import type { DesktopShortcutUnavailable } from "./ipc.js";
import { hasFields, literals, nullableText, number, object, optional, optionalBoolean, record, text, type CommandPlacement, type Declarations, type Shape, type Validator } from "./command-declaration.js";
import type { PhoneRule } from "./phone-commands.js";
import { externalAppCommands } from "./app-commands.js";
import { annotationCommands, fileCommands, imageCommands, imageViewCommands, pasteCommands } from "./attachment-commands.js";
import { automationCommands } from "./automation-commands.js";
import { browserCommands, browserImportCommands } from "./browser-commands.js";
import { cliCommands } from "./cli-commands.js";
import { computerCommands } from "./computer-commands.js";
import { computerUseCommands } from "./computer-use-commands.js";
import { dictationCommands } from "./dictation-commands.js";
import { diffCommands } from "./diff-commands.js";
import { engineCommands } from "./engine-commands.js";
import { projectCommands } from "./project-commands.js";
import { pullRequestCommands } from "./pull-request-commands.js";
import { remoteCommands } from "./remote-commands.js";
import { reviewCommands, runControlCommands } from "./run-commands.js";
import { simulatorCommands } from "./simulator-commands.js";
import { sideChatCommands, taskCommands } from "./task-commands.js";
import { terminalCommands } from "./terminal-commands.js";
import { usageCommands } from "./usage-commands.js";
import { isFindTarget, viewCommands } from "./view-commands.js";
import { worktreeCommands } from "./worktree-commands.js";

export type { CommandPlacement } from "./command-declaration.js";

export type ActionFailedEvent = { type: "action.failed"; message: string; page?: SettingsSection };

/** What a page or a shell found, counted by whoever holds the text. `index` counts from zero. */
export type FindResultsEvent = { type: "find.results"; target: FindTarget; results: FindResults };

export type ShortcutEvent =
  /** The keystroke settings were waiting for, or null when the user pressed Escape instead. */
  | { type: "shortcut.captured"; binding: string | null }
  /** An expected platform limitation for a desktop-wide shortcut, shown with that setting. */
  | { type: "shortcut.unavailable"; refusal: DesktopShortcutUnavailable };

/** What a window reports back besides its commands. */
type ViewEvent = ActionFailedEvent | FindResultsEvent | ShortcutEvent;
export type WorkspaceViewInput = AppCommand | ViewEvent;
type EventShapes = { [Type in ViewEvent["type"]]: Shape<Omit<Extract<ViewEvent, { type: Type }>, "type">> };
type Declared = { fields: Record<string, Validator<unknown>>; at: CommandPlacement; leaves?: true; agent?: (command: never) => boolean; phone?: PhoneRule };
type Commands = typeof commands;
type PlacedType<At extends CommandPlacement> = { [Type in keyof Commands]: Commands[Type]["at"] extends At ? Type : never }[keyof Commands];

/** The commands declared at a placement. */
export type PlacedCommand<At extends CommandPlacement> = Extract<AppCommand, { type: PlacedType<At> }>;
export type AgentCommandType = { [Type in keyof Commands]: Commands[Type] extends { agent: unknown } ? Type : never }[keyof Commands];
export type PhoneCommandType = { [Type in keyof Commands]: Commands[Type] extends { phone: unknown } ? Type : never }[keyof Commands];

/** Whether an input is a command rather than something that happened, which is what may be carried to another computer. */
export function isAppCommandType(type: string): type is AppCommand["type"] {
  return Object.hasOwn(commands, type);
}

export function commandPlacement(type: AppCommand["type"]): CommandPlacement {
  return declarations[type].at;
}

export function commandLeaves(type: AppCommand["type"]): boolean {
  return declarations[type].leaves === true;
}

/** The wire advertises the same actions and fields this validator accepts. New optional fields
 * become capabilities automatically; a changed meaning needs a new field or command name. */
export function workspaceCommandDefinitions(): ReadonlyArray<{ type: AppCommand["type"]; fields: readonly string[] }> {
  return Object.entries(declarations).map(([type, { fields }]) => ({ type: type as AppCommand["type"], fields: Object.keys(fields) }));
}

/** Every input field is checked before a visible view can reach the application reducer. */
export function isWorkspaceViewInput(value: unknown): value is WorkspaceViewInput {
  if (!record(value) || typeof value.type !== "string") return false;
  if (isAppCommandType(value.type)) return hasFields(value, declarations[value.type].fields);
  return Object.hasOwn(events, value.type) && hasFields(value, events[value.type as ViewEvent["type"]]);
}

/**
 * The command surface open to callers outside the window: the commands that declare an agent rule,
 * passing the window's own checks and then that rule. Everything else is the user's alone.
 */
export function isExternalCommand(value: unknown): value is ExternalCommand {
  if (!isWorkspaceViewInput(value) || !isAppCommandType(value.type)) return false;
  const agent = declarations[value.type].agent;
  return agent !== undefined && agent(value as never);
}

/** The command surface open to a paired phone: the commands that declare a phone rule, passing that rule. */
export function isPhoneCommand(value: unknown): value is Extract<AppCommand, { type: PhoneCommandType }> {
  if (!record(value) || typeof value.type !== "string" || !isAppCommandType(value.type)) return false;
  const rule = declarations[value.type].phone;
  return rule !== undefined && rule(value);
}

/** Every command, joined from the table each feature declares beside its commands. */
const commands = {
  ...taskCommands,
  ...sideChatCommands,
  ...annotationCommands,
  ...pasteCommands,
  ...imageCommands,
  ...imageViewCommands,
  ...fileCommands,
  ...cliCommands,
  ...computerUseCommands,
  ...usageCommands,
  ...projectCommands,
  ...pullRequestCommands,
  ...runControlCommands,
  ...reviewCommands,
  ...worktreeCommands,
  ...automationCommands,
  ...browserCommands,
  ...browserImportCommands,
  ...simulatorCommands,
  ...dictationCommands,
  ...diffCommands,
  ...externalAppCommands,
  ...terminalCommands,
  ...remoteCommands,
  ...computerCommands,
  ...engineCommands,
  ...viewCommands,
} satisfies Declarations<AppCommand>;

const declarations: Readonly<Record<AppCommand["type"], Declared>> = commands;

const events = {
  "action.failed": { message: text, page: optional(isSettingsSection) },
  "find.results": { target: isFindTarget, results: object({ matches: number, index: optional(number), counting: optionalBoolean }) },
  "shortcut.captured": { binding: nullableText },
  "shortcut.unavailable": { refusal: object({ reason: literals("unsupported"), binding: text, message: text }) },
} satisfies EventShapes;
