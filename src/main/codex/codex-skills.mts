import type { AvailableCommand } from "../../contracts/ipc.js";
import { appSkillsRoot, unqualifiedSkillName } from "../app-plugin.mjs";
import { CLIENT_INFO, codexAppServer, connectAppServer, type AppServerClient, type AppServerCommand } from "./app-server-client.mjs";
import { APP_FEATURES } from "./codex-config.mjs";
import type { SkillMetadata } from "./protocol/v2/SkillMetadata.js";
import type { UserInput } from "./protocol/v2/UserInput.js";

type SkillsClient = Pick<AppServerClient, "request">;
export type SkillsConnect = (command: AppServerCommand) => Pick<AppServerClient, "initialize" | "request" | "close">;

/** Codex qualifies the app's skills as `aicodingtool:skill`; the app offers and matches them by the short name. */
export async function adoptAppSkills(client: SkillsClient) {
  const root = appSkillsRoot();
  if (root !== undefined) await client.request("skills/extraRoots/set", { extraRoots: [root] });
}

/** The menu and slash invocation use the same enabled skills and name resolution. */
async function readSkills(client: SkillsClient, cwd: string, forceReload: boolean) {
  const result = await client.request("skills/list", { cwds: [cwd], forceReload });
  const skills = result.data.flatMap((entry) => entry.skills).filter((skill) => skill.enabled);
  return [...new Map(skills.map((skill) => [skill.name, skill])).values()];
}

const discovering = new Map<string, Promise<AvailableCommand[]>>();

/** Share concurrent composer reads; the next refresh asks Codex again for installs and config changes. */
export function discoverCodexCommands(cwd: string, connect: SkillsConnect = connectAppServer, timeoutMs = 20_000): Promise<AvailableCommand[]> {
  const pending = discovering.get(cwd);
  if (pending) return pending;
  const reading = discover(cwd, connect, timeoutMs).finally(() => { discovering.delete(cwd); });
  discovering.set(cwd, reading);
  return reading;
}

/** A short-lived server with the same home and bundled-plugin settings as a run. */
async function discover(cwd: string, connect: SkillsConnect, timeoutMs: number): Promise<AvailableCommand[]> {
  const client = connect(await codexAppServer(APP_FEATURES, { cwd }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reading = (async () => {
      await client.initialize(CLIENT_INFO);
      await adoptAppSkills(client);
      return (await readSkills(client, cwd, true)).map((skill) => ({ name: unqualifiedSkillName(skill.name), description: skill.description, argumentHint: "" }));
    })();
    return await Promise.race([
      reading,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Codex did not return its skills in time.")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await client.close();
  }
}

/** The native Codex skills available to one workspace. */
export class CodexSkills {
  private skills: SkillMetadata[] = [];
  private reading: Promise<void> | null = null;

  constructor(private readonly client: SkillsClient, private readonly cwd: string) {}

  /** Refreshes metadata without making skill discovery a condition for running Codex. */
  refresh(forceReload: boolean) {
    if (this.reading) return this.reading;
    const reading: Promise<void> = readSkills(this.client, this.cwd, forceReload)
      .then((skills) => { this.skills = skills; })
      .catch(() => {})
      .finally(() => { if (this.reading === reading) this.reading = null; });
    this.reading = reading;
    return reading;
  }

  /** Waits for an active refresh, then adds every slash skill named in the prompt. */
  async input(prompt: string): Promise<UserInput[]> {
    await this.reading;
    const available = new Map(this.skills.flatMap((skill) => [[skill.name, skill], [unqualifiedSkillName(skill.name), skill]] as const));
    const requested: UserInput[] = [];
    const seen = new Set<string>();
    for (const match of prompt.matchAll(/(?:^|\s)\/([^\s/]+)/g)) {
      const skill = available.get(match[1]!);
      if (!skill || seen.has(skill.name)) continue;
      seen.add(skill.name);
      requested.push({ type: "skill", name: skill.name, path: skill.path });
    }
    return [...requested, { type: "text", text: prompt, text_elements: [] }];
  }
}
