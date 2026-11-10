import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { API } from "typescript/unstable/sync";
import { type Config, type Contract, ContractError, type Named, Reader, type Swift } from "./ios-contract/model.mts";
import { renderCommands, renderTypes, type Uses } from "./ios-contract/swift.mts";

/**
 * Every rule the contract cannot state for itself, in one place. Keys name a field as `Type.field`, a
 * union case's field as `Union.case.field`, and a command's field as `type.field`. An entry that names
 * nothing generated fails the run, as does any contract type no rule maps.
 */
const CONFIG: Config = {
  source: "src/contracts/mobile.ts",
  /** What the phone decodes as a whole: these and every type they reach are generated. */
  read: ["MobileView", "MobileThreadRead", "MobileThreadHistory", "MobileVocabulary", "MobileArchivedThread", "MobileDiffSummary", "MobileDiffPatch", "MobilePatch", "MobileServerMessage"],
  /** What the phone sends: these and every type they reach carry `json`. */
  sent: ["MobileClientMessage"],
  /** Each member of this union is one `PhoneCommand` builder. */
  commands: "MobileCommand",
  /** Contract types the app writes by hand, by the Swift name they go by. */
  handWritten: { MobileCommand: "PhoneCommand" },
  /** Unions of strings the phone reads as a Swift enum, since it must know every value. Others stay strings. */
  enums: ["MobileErrorCode", "PushEnvironment"],
  /** The field that tells a union's members apart, tried in order. */
  discriminators: ["kind", "status"],
  /** Records whose absent and null differ, by the view they change. */
  patches: { MobilePatch: "MobileView", MobileThreadDelta: "MobileThreadView" },
  /** Patch fields the app applies by hand: a transcript's end, a streaming tail, and the open thread. */
  handApplied: ["MobilePatch.thread", "MobileThreadDelta.spliced", "MobileThreadDelta.tail"],
  /** Unions read from a frame's JSON by the field every member carries, which the app reads first. */
  frames: { MobileServerMessage: "sequence" },
  /** Cases whose `ok` chooses between a value and a failure's message. */
  results: { "MobileServerMessage.answer": { ok: "ok", success: "result", failure: "message" } },
  /** The case an unknown discriminator reads as, so a newer computer's value does not fail the whole view. */
  fallbacks: { MobileLocation: "local", DiffRange: "uncommitted", DiffSummaryResult: "error", DiffPatchResult: "error" },
  /** What a field reads as when it is left out, or, on a struct, its memberwise default. */
  defaults: {
    "MobileActivity.priority": "[]",
    "MobileActivity.running": "[]",
    "MobileActivity.threads": "[]",
    "MobileActivity.snoozed": "[]",
    "MobileLocation.worktree.threads": "1",
    "DiffSummaryResult.error.message": "\"The comparison could not be read.\"",
    "DiffPatchResult.error.message": "\"The file could not be read.\"",
    "MobileServerMessage.ack.message": "\"\"",
    "MobileServerMessage.answer.message": "\"\"",
    "MobileServerMessage.error.message": "\"\"",
  },
  /** Fields the contract requires that the phone still reads as optional, since older computers leave them out. */
  optionalOnPhone: ["MobileView.upkeep", "MobileView.dictation", "MobileView.usage"],
  /** Plain numbers outside this contract that the phone reads as whole. */
  integers: ["DiffFileSummary.additions", "DiffFileSummary.deletions", "DiffSummaryResult.available.additions", "DiffSummaryResult.available.deletions"],
  /** Fields the phone has no use for, which it neither reads nor requires. */
  ignored: ["DiffSummaryResult.available.ignoreWhitespace", "DiffSummaryResult.unknown.workspaceId", "DiffPatchResult.too-large.limit"],
  /** Fields a phone's command may never carry, which its rule on the computer refuses. */
  unsent: [
    "task.send.attachments", "task.send.model", "task.send.engine", "task.send.effort", "task.send.role", "task.send.coordinatorId",
    "task.send.brief", "task.send.title", "task.send.from", "task.send.sender", "task.send.lead", "task.send.memory",
    "task.set-role.sender", "task.move-worktree.afterRun", "task.move-worktree.sender", "task.move-worktree.then",
    "proposal.start.proposalIds", "proposal.start.place", "project.add.computerId", "app.update.computerId", "app.cancel-update.computerId",
    "engine.update.computerId", "usage.read.everywhere", "OutgoingAttachment.path", "OutgoingAttachment.context",
  ],
  /** Fields of what the phone sends that it fills from its own constants. */
  filled: { "MobileClientMessage.version": "mobileProtocolVersion", "MobileClientMessage.oldestComputer": "oldestComputerProtocolVersion" },
};

/** Conformances beyond the generated ones, by Swift type name. */
const CONFORMANCES: Record<string, string[]> = {
  MobileArchivedThread: ["Identifiable"],
  MobileBackgroundItem: ["Identifiable"],
  MobileDecision: ["Identifiable"],
  MobileMember: ["Identifiable"],
  MobileQueuedMessage: ["Identifiable"],
  MobileRoleTerm: ["Identifiable"],
  MobileSuggestion: ["Identifiable"],
  MobileThreadEntry: ["Identifiable"],
  MobileUsageWindow: ["Identifiable"],
  MobileWorktreeChoice: ["Identifiable"],
  DiffRange: ["Hashable"],
};

const root = path.resolve(import.meta.dirname, "..");
const projectName = "tsconfig.main.json";
const HEADER = [
  "// Generated by scripts/generate-ios-contract.mts from src/contracts/mobile.ts and the types it names. Do not",
  "// edit: run npm run generate:ios-contract. Values a newer computer may extend (statuses, engines, models,",
  "// efforts, modes) are kept as strings, so an unknown one is shown as it was sent rather than failing",
  "// the whole view.",
  "",
  "import Foundation",
];
const TYPES = "ios/AICodingTool/Protocol/Contract.generated.swift";
const COMMANDS = "ios/AICodingTool/Protocol/Commands.generated.swift";

function references(swift: Swift): string[] {
  if (swift.kind === "named") return [swift.name];
  if (swift.kind === "array") return references(swift.element);
  if (swift.kind === "map") return references(swift.value);
  if (swift.kind === "result") return [...references(swift.success.swift), ...references(swift.failure.swift)];
  return [];
}

function children(type: Named | undefined): string[] {
  if (!type || type.kind === "enum") return [];
  const structs = type.kind === "struct" ? [type, ...nestedOf(type)] : [];
  const fields = type.kind === "struct" ? structs.flatMap((struct) => struct.fields) : type.cases.flatMap((entry) => entry.fields);
  return fields.flatMap((field) => references(field.swift));
}

function nestedOf(type: Named): Named[] {
  return type.kind === "struct" ? type.nested.flatMap((nested) => [nested, ...nestedOf(nested)]) : [];
}

function closure(contract: Contract, roots: string[]): Set<string> {
  const reached = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (reached.has(name)) continue;
    reached.add(name);
    pending.push(...children(contract.types.get(name)));
  }
  return reached;
}

function uses(contract: Contract): Uses {
  const records = [...contract.types.values()].filter((type) => type.kind === "struct" && !type.patch).map((type) => type.name);
  const commands = contract.commands.flatMap((command) => command.fields.flatMap((field) => references(field.swift)));
  return {
    read: closure(contract, contract.read),
    sent: closure(contract, [...contract.sent, ...commands]),
    stored: closure(contract, records),
    conformances: CONFORMANCES,
  };
}

function stale(reader: Reader, contract: Contract): string[] {
  const checks: Array<[string, string[]]> = [
    ["hand", Object.keys(CONFIG.handWritten)], ["enum", CONFIG.enums], ["patch", Object.keys(CONFIG.patches)], ["applied", CONFIG.handApplied],
    ["frame", Object.keys(CONFIG.frames)], ["result", Object.keys(CONFIG.results)], ["default", Object.keys(CONFIG.defaults)],
    ["optional", CONFIG.optionalOnPhone], ["integer", CONFIG.integers], ["ignored", CONFIG.ignored], ["unsent", CONFIG.unsent], ["filled", Object.keys(CONFIG.filled)],
  ];
  const unused = checks.flatMap(([kind, keys]) => keys.filter((key) => !reader.used.has(`${kind}:${key}`)).map((key) => `${kind} ${key}`));
  const fallbacks = Object.keys(CONFIG.fallbacks).filter((name) => !reader.used.has(`fallback:${name}`));
  const conformances = Object.keys(CONFORMANCES).filter((name) => !contract.types.has(name));
  return [...unused, ...fallbacks.map((name) => `fallback ${name}`), ...conformances.map((name) => `conformance ${name}`)];
}

function generated(): Map<string, string> {
  const api = new API({ cwd: root });
  try {
    const configFile = path.join(root, projectName);
    const project = api.updateSnapshot({ openProjects: [configFile] }).getProject(configFile);
    if (!project) throw new ContractError(`${projectName} could not be opened.`);
    const reader = new Reader(project, root, CONFIG);
    const contract = reader.read();
    const unused = stale(reader, contract);
    if (unused.length > 0) throw new ContractError(`Configuration names nothing generated: ${unused.join(", ")}.`);
    const used = uses(contract);
    return new Map([
      [TYPES, `${[...HEADER, ...renderTypes(contract, used)].join("\n")}\n`],
      [COMMANDS, `${[...HEADER, ...renderCommands(contract.commands)].join("\n")}\n`],
    ]);
  } finally {
    api.close();
  }
}

let outputs: Map<string, string>;
try {
  outputs = generated();
} catch (error) {
  if (!(error instanceof ContractError)) throw error;
  console.error(error.message);
  process.exit(1);
}
const check = process.argv.includes("--check");
for (const [name, written] of outputs) {
  const target = path.join(root, name);
  if (!check) {
    writeFileSync(target, written);
    continue;
  }
  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch {
    // A missing file is stale.
  }
  if (current !== written) {
    console.error(`${name} is out of date. Run npm run generate:ios-contract.`);
    process.exit(1);
  }
}
