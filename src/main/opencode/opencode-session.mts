import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { QuestionAnswers, QuestionRequest } from "../../domain/agent-question.js";
import type { ToolIntent } from "../../domain/run.js";
import { continuationOf, type ProviderResult, type ProviderRunInput } from "../agent/agent-provider.mjs";
import { appSkillsRoot } from "../app-plugin.mjs";
import { appendCompleteMarkdown, openMarkdownBuffer, type MarkdownBuffer } from "../agent/markdown-buffer.mjs";
import { TurnSlot, type SessionTurn } from "../agent/session-turn.mjs";
import { SIDE_CHAT_BOUNDARY } from "../agent/side-chat-instructions.mjs";
import type { ServedTools, ToolHost } from "../tools/mcp-http-host.mjs";
import { modelRef, type OpenCodeModel } from "./opencode-catalog.mjs";
import { openCodeBrief } from "./opencode-instructions.mjs";
import { agentFor, APP_SERVER_NAME, COMPUTER_USE_SERVER_NAME, permissionRules, type PermissionRule } from "./opencode-policy.mjs";
import { FEED_ENDED, OpenCodeError, OpenCodeExited, readLoaded, type OpenCodeClient, type OpenCodeConnect, type OpenCodeEvent } from "./opencode-server.mjs";

/** How long an interrupted turn has to come back with a result before the session is given up on. */
const INTERRUPT_GRACE_MS = 10_000;
/** How long a lost feed waits for its server's exit, which says why it went. */
const EXIT_WAIT_MS = 500;

type Data = Record<string, unknown>;
type SessionInfo = { id: string; location?: { directory?: string } };
type FormField = { key: string; type: string; title?: string; description?: string; options?: { value: string; label: string; description?: string }[] };
type FormInfo = { id: string; sessionID: string; title: string; fields: FormField[] };

function isRecord(value: unknown): value is Data {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function firstLine(message: string) {
  return message.split("\n", 1)[0] ?? message;
}

function reasonOf(error: unknown) {
  return firstLine(error instanceof Error ? error.message : String(error));
}

/** Tokens a response read and wrote, as the server counts a step. */
function tokensOf(value: unknown): number {
  if (!isRecord(value)) return 0;
  const cache = isRecord(value.cache) ? value.cache : {};
  const count = (part: unknown) => typeof part === "number" && Number.isFinite(part) ? part : 0;
  return count(value.input) + count(value.output) + count(value.reasoning) + count(cache.read) + count(cache.write);
}

/** The app's own tools are filed under one server; their bare name is what reads, and what the app knows them by. */
export function toolName(name: string) {
  const prefix = `${APP_SERVER_NAME}_`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/** What a tool call is about, in the shape the thread records tools in. A write names the file it changes. */
export function intentOf(toolId: string, name: string, input: unknown, root: string): ToolIntent {
  const args = isRecord(input) ? input : {};
  const file = text(args.filePath) ?? text(args.path);
  const writes = ["write", "edit", "apply_patch", "patch", "multiedit"].includes(name);
  return { toolId, name: toolName(name), input: args, ...(writes && file ? { writePath: path.resolve(root, file) } : {}) };
}

/** A form OpenCode puts to the user, asked as the composer asks its questions: one per field. */
export function questionsOf(form: FormInfo): QuestionRequest | null {
  const fields = form.fields.filter((field) => field.type !== "external");
  if (!fields.length) return null;
  return {
    blocking: true,
    questions: fields.map((field) => ({
      id: field.key,
      header: field.title ?? form.title,
      question: field.description ?? field.title ?? form.title,
      options: field.type === "boolean"
        ? [{ label: "Yes", description: "" }, { label: "No", description: "" }]
        : (field.options ?? []).map((option) => ({ label: option.label, description: option.description ?? "" })),
    })),
  };
}

/** The answers to a form, each in the type its field takes. */
export function formAnswer(form: FormInfo, answers: QuestionAnswers): Record<string, string | number | boolean | string[]> {
  const answer: Record<string, string | number | boolean | string[]> = {};
  for (const field of form.fields) {
    const given = answers[field.key];
    if (given === undefined) continue;
    const chosen = field.options?.find((option) => option.label === given)?.value ?? given;
    if (field.type === "boolean") answer[field.key] = /^(yes|true)$/i.test(given.trim());
    else if (field.type === "number" || field.type === "integer") answer[field.key] = Number(given);
    else if (field.type === "multiselect") answer[field.key] = given.split(",").map((part) => field.options?.find((option) => option.label === part.trim())?.value ?? part.trim()).filter(Boolean);
    else answer[field.key] = chosen;
  }
  return answer;
}

/** Why the session could not open, worded for the run that asked. `lost` says the continuation itself is gone. */
class OpenFailure extends Error {
  constructor(message: string, readonly lost = false) {
    super(message);
  }
}

function openFailure(error: unknown) {
  if (error instanceof OpenFailure) return error.message;
  return `OpenCode could not start: ${reasonOf(error)}`;
}

type Turn = SessionTurn & {
  /** Messages this turn put in the session's inbox that it has yet to take, and those it has taken. */
  waiting: Set<string>;
  delivered: Set<string>;
  /** Assistant text still buffered per part, so a half-written block never ships. */
  streamed: Map<string, MarkdownBuffer>;
  /** Tool names by call id, which the call itself does not repeat, and each call as it was shown. */
  tools: Map<string, string>;
  intents: Map<string, ToolIntent>;
  /** Set once the server has the turn's prompt, so an interrupt has something to stop. */
  started?: boolean;
  interruptWanted?: boolean;
  compacting?: boolean;
  compactionPreTokens?: number;
  failure?: string;
};

/**
 * One OpenCode session, kept across turns on a server of its own. The server belongs to the session
 * because the app's tools and the run's instructions are given to it as it starts, so a run that
 * needs others gets a session of its own.
 */
export class OpenCodeSession {
  private client: OpenCodeClient | null = null;
  private served: ServedTools | null = null;
  private opening: Promise<void> | null = null;
  private readonly turns = new TurnSlot<Turn>(INTERRUPT_GRACE_MS, () => this.close());
  private ended = false;
  private closed: Promise<void> = Promise.resolve();
  private outcome: ProviderResult | null = null;
  private announced = false;
  private briefFile: string | null = null;
  /** Context windows, and the depths each model reasons at, by app model id, read once from the server. */
  private readonly windows = new Map<string, number>();
  private readonly variants = new Map<string, Set<string>>();
  /** The skills and commands slash names reach, read while the first turn starts and waited on only by one that names any. */
  private slashes: Promise<{ skills: Set<string>; commands: Set<string> }> = Promise.resolve({ skills: new Set(), commands: new Set() });
  /** The sessions this one's own agents opened, whose questions are this session's to answer. */
  private readonly children = new Set<string>();
  private settings: { model?: string; variant?: string; agent?: string; rules?: string } = {};
  private lastTokens = 0;
  private unsubscribe: (() => void) | null = null;
  /** What OpenCode calls the session. A later run resumes it by this id. */
  sessionId?: string;

  constructor(
    readonly key: string,
    private readonly connect: OpenCodeConnect,
    private readonly host: ToolHost,
    private readonly onEnded: () => void,
    private readonly onRested: () => void,
  ) {}

  get answering() {
    return this.turns.answering;
  }

  get busy() {
    return this.answering;
  }

  get live() {
    return !this.ended;
  }

  private get turn() {
    return this.turns.turn;
  }

  continues(continuation: string | undefined) {
    return continuation === undefined || continuation === this.sessionId;
  }

  run(input: ProviderRunInput): Promise<ProviderResult> {
    if (this.ended) return Promise.resolve(this.outcome ?? { status: "failed", message: "The OpenCode session ended before the run could start." });
    return this.turns.take(input, {
      open: (base) => ({ ...base, waiting: new Set(), delivered: new Set(), streamed: new Map(), tools: new Map(), intents: new Map() }),
      begin: (turn) => { void this.begin(turn); },
      interrupt: (turn) => { this.interrupt(turn); },
    });
  }

  close() {
    if (this.ended) return this.closed;
    this.ended = true;
    this.turns.settle({ status: "cancelled" });
    this.unsubscribe?.();
    this.closed = (this.client?.close() ?? Promise.resolve()).then(() => this.briefFile ? rm(this.briefFile, { force: true }) : undefined).catch(() => {});
    this.client = null;
    this.served?.release();
    this.served = null;
    this.onEnded();
    return this.closed;
  }

  /** Names the session in OpenCode's own history, so it reads there as it reads here. */
  label(title: string) {
    if (this.client && this.sessionId) void this.client.request("PATCH", `/api/session/${this.sessionId}`, { title }).catch(() => {});
  }

  /** Files a session away in OpenCode's history, or brings it back, on this session's server. False when it has none to ask. */
  async file(sessionId: string, archived: boolean) {
    if (!this.client || this.ended) return false;
    await this.client.request("PATCH", `/api/session/${sessionId}`, { archived });
    return true;
  }

  private async begin(turn: Turn) {
    try {
      await (this.opening ??= this.open(turn.input));
    } catch (error) {
      if (this.turn === turn) {
        if (error instanceof OpenFailure && error.lost) turn.input.emit({ type: "continuation-lost" });
        this.turns.settle({ status: "failed", message: openFailure(error) });
      }
      void this.close();
      return;
    }
    const client = this.client;
    const sessionId = this.sessionId;
    if (this.turn !== turn || !client || !sessionId) return;
    if (!this.announced) {
      this.announced = true;
      turn.input.emit({ type: "continuation", continuation: { provider: "opencode", value: sessionId } });
    }
    try {
      await this.apply(client, sessionId, turn.input);
      if (this.turn !== turn) return;
      turn.started = true;
      if (turn.input.operation?.type === "compact") {
        this.setCompacting(turn, true);
        await client.request("POST", `/api/session/${sessionId}/compact`, {});
        return;
      }
      await this.send(client, sessionId, turn, turn.input.prompt, "queue");
    } catch (error) {
      if (this.turn === turn) this.turns.settle({ status: "failed", message: `OpenCode could not start the turn: ${reasonOf(error)}` });
      return;
    }
    if (turn.interruptWanted) {
      this.interrupt(turn);
      return;
    }
    await this.drainSteering(turn);
  }

  /** Puts a message in the session's inbox: a slash command as the command it names, a skill as that skill. */
  private async send(client: OpenCodeClient, sessionId: string, turn: Turn, prompt: string, delivery: "queue" | "steer") {
    const named = /(?:^|\s)\/[^\s/]/.test(prompt);
    const { skills: known, commands } = named ? await this.slashes : { skills: new Set<string>(), commands: new Set<string>() };
    const command = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(prompt.trim());
    if (command && commands.has(command[1]!)) {
      const sent = await client.request<{ id?: string }>("POST", `/api/session/${sessionId}/command`, { name: command[1], text: command[2] ?? "", delivery });
      this.awaitDelivery(turn, sent?.id);
      return;
    }
    const skills = [...new Set([...prompt.matchAll(/(?:^|\s)\/([^\s/]+)/g)].map((match) => match[1]!).filter((name) => known.has(name)))];
    const sent = await client.request<{ id?: string }>("POST", `/api/session/${sessionId}/prompt`, {
      text: prompt,
      ...(skills.length ? { skills: skills.map((id) => ({ id })) } : {}),
      delivery,
    });
    this.awaitDelivery(turn, sent?.id);
  }

  /** The server may take a message before saying it has it, so one already taken is not waited on. */
  private awaitDelivery(turn: Turn, inboxId: string | undefined) {
    if (inboxId && !turn.delivered.has(inboxId)) turn.waiting.add(inboxId);
  }

  /** Brings the session to the run's model, effort, mode and tools, saying only what changed. */
  private async apply(client: OpenCodeClient, sessionId: string, input: ProviderRunInput) {
    const ref = modelRef(input.model, this.variantOf(input));
    if (!ref) throw new OpenFailure(`OpenCode cannot run the ${input.model} model.`);
    if (ref.providerID + ref.id !== this.settings.model || ref.variant !== this.settings.variant) {
      await client.request("POST", `/api/session/${sessionId}/model`, { model: ref });
      this.settings.model = ref.providerID + ref.id;
      this.settings.variant = ref.variant;
    }
    const agent = agentFor(input.policy);
    if (agent !== this.settings.agent) {
      await client.request("POST", `/api/session/${sessionId}/agent`, { agent });
      this.settings.agent = agent;
    }
    const rules = this.rules(input);
    const written = JSON.stringify(rules);
    if (written !== this.settings.rules) {
      await client.request("PATCH", `/api/session/${sessionId}`, { permissions: rules });
      this.settings.rules = written;
    }
  }

  /** The effort is passed on only as a depth the model offers; one that offers none takes none. */
  private variantOf(input: ProviderRunInput) {
    return this.variants.get(input.model)?.has(input.effort) ? input.effort : undefined;
  }

  private rules(input: ProviderRunInput): PermissionRule[] {
    const sets = openCodeBrief(input).tools;
    return permissionRules(input, sets, input.computerUse.status === "available");
  }

  /** Starts the server with the app's tools and instructions, and puts the run's session on it. */
  private async open(seed: ProviderRunInput) {
    const brief = openCodeBrief(seed);
    const tools = brief.tools.flatMap((set) => set.tools);
    if (tools.length) {
      const served = await this.host.serve(tools);
      if (this.ended) {
        served.release();
        throw new OpenFailure("The OpenCode session ended before the run could start.");
      }
      this.served = served;
    }
    const folder = path.join(os.tmpdir(), "aicodingtool-opencode");
    await mkdir(folder, { recursive: true });
    this.briefFile = path.join(folder, `${randomUUID()}.md`);
    await writeFile(this.briefFile, brief.instructions.join("\n\n"), { mode: 0o600 });
    const mcp: Data = {};
    if (this.served) mcp[APP_SERVER_NAME] = { type: "remote", url: this.served.url, headers: { Authorization: `Bearer ${this.served.token}` }, oauth: false, codemode: false };
    if (seed.computerUse.status === "available") {
      const { command, args, env } = seed.computerUse.mcp;
      mcp[COMPUTER_USE_SERVER_NAME] = { type: "local", command: [command, ...args], environment: env, codemode: false };
    }
    const skills = appSkillsRoot();
    const config = { mcp, instructions: [this.briefFile], ...(skills ? { skills: [skills] } : {}) };
    const client = this.client = await this.connect({ cwd: seed.workspaceRoot, config });
    if (this.ended) throw new OpenFailure("The OpenCode session ended before the run could start.");
    this.unsubscribe = client.subscribe((event) => this.receive(event));
    void client.exited.then((exit) => this.exited(new OpenCodeExited(exit)));
    const location = `location[directory]=${encodeURIComponent(seed.workspaceRoot)}`;
    this.slashes = Promise.all([
      readLoaded<{ id: string }>(client, `/api/skill?${location}`).catch(() => []),
      readLoaded<{ name: string }>(client, `/api/command?${location}`).catch(() => []),
    ]).then(([skills, commands]) => ({ skills: new Set(skills.map((skill) => skill.id)), commands: new Set(commands.map((command) => command.name)) }));
    const models = await client.request<OpenCodeModel[]>("GET", `/api/model?${location}`).catch(() => []);
    for (const model of models) {
      const id = `${model.providerID}/${model.id}`;
      if (model.limit?.context) this.windows.set(id, model.limit.context);
      this.variants.set(id, new Set((model.variants ?? []).map((variant) => variant.id)));
    }
    const continuation = continuationOf(seed);
    const ref = modelRef(seed.model, this.variantOf(seed));
    if (!ref) throw new OpenFailure(`OpenCode cannot run the ${seed.model} model.`);
    const create = () => client.request<SessionInfo>("POST", "/api/session", {
      location: { directory: seed.workspaceRoot },
      model: ref,
      agent: agentFor(seed.policy),
      permissions: this.rules(seed),
      metadata: { aicodingtool: seed.taskId },
    });
    let session: SessionInfo;
    if (continuation === undefined) {
      session = await create();
    } else {
      let held: SessionInfo;
      try {
        held = await client.request<SessionInfo>("GET", `/api/session/${continuation}`);
      } catch (error) {
        if (error instanceof OpenCodeError && error.status === 404) throw new OpenFailure(`OpenCode could not continue this session (${error.message}). Start a new thread to keep going.`, true);
        throw error;
      }
      /** A session with nothing in it has nothing to copy, so a fork of one starts afresh. */
      session = seed.forkContinuation
        ? await client.request<SessionInfo>("POST", `/api/session/${continuation}/fork`, {}).catch((error: unknown) => {
          if (error instanceof OpenCodeError && error.status === 400 && /empty session/i.test(error.message)) return create();
          throw error;
        })
        : held;
      /** A session works where it was opened, and a fork where its parent was, so one taken into another checkout is moved there. */
      if (session.location?.directory !== seed.workspaceRoot) {
        await client.request("POST", `/api/session/${session.id}/move`, { directory: seed.workspaceRoot });
      }
    }
    this.sessionId = session.id;
    if (seed.channel === "side" && (continuation === undefined || seed.forkContinuation)) {
      await client.request("POST", `/api/session/${session.id}/synthetic`, { text: SIDE_CHAT_BOUNDARY, resume: false });
    }
  }

  private interrupt(turn: Turn) {
    if (!turn.started) {
      turn.interruptWanted = true;
      return;
    }
    if (this.client && this.sessionId) void this.client.request("POST", `/api/session/${this.sessionId}/interrupt`).catch(() => {});
  }

  /** Feeds one run's steered messages into the session as it works, each taken at its next step. */
  private async drainSteering(turn: Turn) {
    for (let steer = await turn.input.steering.next(); steer; steer = await turn.input.steering.next()) {
      const client = this.client;
      const sessionId = this.sessionId;
      if (this.turn !== turn || !client || !sessionId) return;
      try {
        await this.send(client, sessionId, turn, steer.prompt, "steer");
        turn.input.emit({ type: "steered", messageId: steer.messageId });
      } catch (error) {
        if (this.turn !== turn) return;
        turn.input.emit({ type: "steer-failed", messageId: steer.messageId, message: `Could not steer: ${reasonOf(error)}. Your message is still queued for the next turn.` });
      }
    }
  }

  private exited(error: OpenCodeExited) {
    this.lost(`OpenCode stopped: ${error.message}`);
  }

  /** A feed usually ends because its server died, whose own exit says why, so that is waited on briefly before the bare loss is reported. */
  private feedEnded() {
    const exited = this.client?.exited.then((exit) => `OpenCode stopped: ${new OpenCodeExited(exit).message}`);
    const quiet = new Promise<string>((resolve) => setTimeout(() => resolve("OpenCode stopped sending events"), EXIT_WAIT_MS));
    void Promise.race([...exited ? [exited] : [], quiet]).then((message) => this.lost(message));
  }

  /** A server the session can no longer hear is given up on: its turn fails, and the next run opens a fresh one. */
  private lost(message: string) {
    if (this.ended) return;
    this.outcome = { status: "failed", message };
    this.turns.settle(this.outcome);
    void this.close();
  }

  /** Whether an event belongs to this session or to one its own agents opened. */
  private owns(sessionId: unknown) {
    return typeof sessionId === "string" && (sessionId === this.sessionId || this.children.has(sessionId));
  }

  private receive(event: OpenCodeEvent) {
    if (event.type === FEED_ENDED) {
      this.feedEnded();
      return;
    }
    const data = event.data ?? {};
    if (event.type === "session.created" && typeof data.parentID === "string" && this.owns(data.parentID) && typeof data.sessionID === "string") {
      this.children.add(data.sessionID);
      return;
    }
    if (event.type === "permission.asked") {
      if (this.owns(data.sessionID)) this.decide(data);
      return;
    }
    if (event.type === "form.created") {
      const form = isRecord(data.form) ? data.form as unknown as FormInfo : undefined;
      if (form && this.owns(form.sessionID)) this.ask(form);
      return;
    }
    if (data.sessionID !== this.sessionId) return;
    const turn = this.turn;
    if (!turn) return;
    switch (event.type) {
      case "session.inbox.delivered":
        if (typeof data.inboxID === "string") {
          turn.delivered.add(data.inboxID);
          turn.waiting.delete(data.inboxID);
        }
        return;
      case "session.text.delta":
        this.receiveDelta(turn, `${String(data.assistantMessageID)}:${String(data.ordinal)}`, text(data.delta) ?? "");
        return;
      case "session.text.ended":
        this.receiveText(turn, `${String(data.assistantMessageID)}:${String(data.ordinal)}`, text(data.text) ?? "");
        return;
      case "session.tool.input.started":
        if (typeof data.id === "string" && typeof data.name === "string") turn.tools.set(data.id, data.name);
        return;
      case "session.tool.called": {
        if (typeof data.id !== "string") return;
        const intent = intentOf(data.id, turn.tools.get(data.id) ?? "tool", data.input, turn.input.workspaceRoot);
        turn.intents.set(data.id, intent);
        turn.input.emit({ type: "tool", intent });
        return;
      }
      case "session.step.ended": {
        const tokens = tokensOf(data.tokens);
        if (!tokens) return;
        this.lastTokens = tokens;
        turn.input.emit({ type: "spend", tokens });
        turn.input.emit({ type: "usage", tokens, limit: this.windows.get(turn.input.model) ?? 0, model: turn.input.model });
        return;
      }
      case "session.retry.scheduled":
        turn.input.emit({ type: "retry", message: text(data.message) ?? text(isRecord(data.error) ? data.error.message : undefined) ?? "OpenCode is retrying the request." });
        return;
      case "session.compaction.started":
        this.setCompacting(turn, true);
        return;
      case "session.compaction.ended": {
        const manual = turn.input.operation?.type === "compact";
        turn.input.emit({ type: "compaction", trigger: manual ? "manual" : "auto", preTokens: turn.compactionPreTokens ?? this.lastTokens });
        this.setCompacting(turn, false);
        if (manual) this.turns.settle({ status: "succeeded" });
        return;
      }
      case "session.compaction.failed":
        this.setCompacting(turn, false, `Could not compact context: ${text(data.message) ?? "OpenCode could not compact this session."}`);
        if (turn.input.operation?.type === "compact") this.turns.settle({ status: "failed" });
        return;
      case "session.execution.failed":
        turn.failure = text(data.message) ?? text(isRecord(data.error) ? data.error.message : undefined) ?? "OpenCode could not finish the turn.";
        this.finish(turn, { status: "failed", message: turn.failure });
        return;
      case "session.execution.interrupted":
        this.finish(turn, { status: "cancelled" });
        return;
      case "session.execution.succeeded":
        this.finish(turn, { status: "succeeded" });
        return;
    }
  }

  /** A turn ends with the execution that took its last message; one still waiting in the inbox runs next. */
  private finish(turn: Turn, result: ProviderResult) {
    if (this.turn !== turn || !turn.started || turn.input.operation?.type === "compact") return;
    if (result.status === "succeeded" && turn.waiting.size) return;
    for (const [key, buffer] of turn.streamed) {
      if (buffer.text) turn.input.emit({ type: "assistant", messageId: key, text: buffer.text, append: true });
    }
    turn.streamed.clear();
    this.turns.settle(result);
    this.onRested();
  }

  private receiveDelta(turn: Turn, key: string, delta: string) {
    let buffer = turn.streamed.get(key);
    if (!buffer) turn.streamed.set(key, buffer = openMarkdownBuffer());
    const complete = appendCompleteMarkdown(buffer, delta);
    if (complete) turn.input.emit({ type: "assistant", messageId: key, text: complete, append: true });
    turn.input.emit({ type: "assistant-tail", messageId: key, text: buffer.text });
  }

  /** A part that streamed is on screen but for its tail; one that did not arrives whole. */
  private receiveText(turn: Turn, key: string, whole: string) {
    const buffer = turn.streamed.get(key);
    if (buffer) {
      turn.streamed.delete(key);
      if (buffer.text) turn.input.emit({ type: "assistant", messageId: key, text: buffer.text, append: true });
    } else if (whole.trim()) {
      turn.input.emit({ type: "assistant", messageId: key, text: whole });
    }
  }

  private setCompacting(turn: Turn, compacting: boolean, error?: string) {
    if (this.turn !== turn) return;
    if (compacting && turn.compactionPreTokens === undefined) {
      turn.compactionPreTokens = turn.input.operation?.type === "compact" ? turn.input.operation.preTokens : this.lastTokens;
    }
    if (turn.compacting === compacting && error === undefined) return;
    turn.compacting = compacting;
    turn.input.emit({ type: "compaction-status", compacting, ...(error ? { error } : {}) });
  }

  /** Puts a tool the rules left to ask about to the run's user. Nothing is allowed on a session with no run to ask. */
  private decide(request: Data) {
    const client = this.client;
    const turn = this.turn;
    if (!client || typeof request.id !== "string" || typeof request.sessionID !== "string") return;
    const reply = (decision: "once" | "reject") => client.request("POST", `/api/session/${request.sessionID}/permission/${request.id}/reply`, { decision }).catch(() => {});
    if (!turn) {
      void reply("reject");
      return;
    }
    const source = isRecord(request.source) ? request.source : {};
    const metadata = isRecord(request.metadata) ? request.metadata : {};
    const action = text(request.action) ?? "tool";
    const input = isRecord(metadata.input) ? metadata.input : { resources: request.resources };
    /** The call the rules asked about, as it was shown, says more than the rule's own name for it. */
    const intent = turn.intents.get(text(source.id) ?? "") ?? intentOf(text(source.id) ?? request.id, action, input, turn.input.workspaceRoot);
    void turn.input.authorize(intent).then((decision) => reply(decision === "allow" ? "once" : "reject"), () => reply("reject"));
  }

  /** A form goes to the user as the composer's questions; one nobody answers is withdrawn. */
  private ask(form: FormInfo) {
    const client = this.client;
    const turn = this.turn;
    const request = questionsOf(form);
    const cancel = () => client?.request("DELETE", `/api/session/${form.sessionID}/form/${form.id}`).catch(() => {});
    if (!client || !turn || !request) {
      void cancel();
      return;
    }
    const controller = new AbortController();
    turn.input.abortController.signal.addEventListener("abort", () => controller.abort(), { once: true });
    void turn.input.askQuestion(request, controller.signal).then((answers) => {
      if (answers === null) return cancel();
      return client.request("POST", `/api/session/${form.sessionID}/form/${form.id}/reply`, { answer: formAnswer(form, answers) });
    }).catch(() => cancel());
  }
}
