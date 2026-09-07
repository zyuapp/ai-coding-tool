import type { AppServerClient } from "./app-server-client.mjs";
import type { SkillMetadata } from "./protocol/v2/SkillMetadata.js";
import type { UserInput } from "./protocol/v2/UserInput.js";

type SkillsClient = Pick<AppServerClient, "request">;

/** The native Codex skills available to one workspace. */
export class CodexSkills {
  private skills: SkillMetadata[] = [];
  private reading: Promise<void> | null = null;

  constructor(private readonly client: SkillsClient, private readonly cwd: string) {}

  /** Refreshes metadata without making skill discovery a condition for running Codex. */
  refresh(forceReload: boolean) {
    if (this.reading) return this.reading;
    const reading: Promise<void> = this.client.request("skills/list", { cwds: [this.cwd], forceReload })
      .then((result) => { this.skills = result.data.flatMap((entry) => entry.skills); })
      .catch(() => {})
      .finally(() => { if (this.reading === reading) this.reading = null; });
    this.reading = reading;
    return reading;
  }

  /** Waits for an active refresh, then adds every slash skill named in the prompt. */
  async input(prompt: string): Promise<UserInput[]> {
    await this.reading;
    const available = new Map(this.skills.filter((skill) => skill.enabled).map((skill) => [skill.name, skill.path]));
    const requested: UserInput[] = [];
    const seen = new Set<string>();
    for (const match of prompt.matchAll(/(?:^|\s)\/([^\s/]+)/g)) {
      const name = match[1]!;
      const path = available.get(name);
      if (!path || seen.has(name)) continue;
      seen.add(name);
      requested.push({ type: "skill", name, path });
    }
    return [...requested, { type: "text", text: prompt, text_elements: [] }];
  }
}
