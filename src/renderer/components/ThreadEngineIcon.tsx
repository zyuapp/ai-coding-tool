import type { IconType } from "react-icons";
import { BsClaude, BsOpenai } from "react-icons/bs";
import { engineLabel, type AgentEngine } from "../../domain/agent-engine";

const ENGINE_ICONS: Record<AgentEngine, IconType> = {
  claude: BsClaude,
  codex: BsOpenai,
};

/** A thread's provider mark stays compact enough to sit beside its other identity marks. */
export function ThreadEngineIcon({ engine, className, size }: { engine: AgentEngine; className?: string; size: number }) {
  const Icon = ENGINE_ICONS[engine];
  return <Icon className={className} size={size} aria-label={`${engineLabel(engine)} thread`} />;
}
