import type { IconType } from "react-icons";
import { BsClaude, BsOpenai } from "react-icons/bs";
import { LuMessageSquare as MessageSquare } from "react-icons/lu";
import { SiOpencode } from "react-icons/si";
import { engineLabel, isAgentEngine, type AgentEngine, type EngineId } from "../../domain/agent-engine";

const ENGINE_ICONS: Record<AgentEngine, IconType> = {
  claude: BsClaude,
  codex: BsOpenai,
  opencode: SiOpencode,
};

/** A thread's provider mark, or a plain thread's for an engine this build does not know. */
export function engineIcon(engine: EngineId): IconType {
  return isAgentEngine(engine) ? ENGINE_ICONS[engine] : MessageSquare;
}

/** A thread's provider mark stays compact enough to sit beside its other identity marks. An engine this build does not know draws none. */
export function ThreadEngineIcon({ engine, className, size }: { engine: EngineId; className?: string; size: number }) {
  if (!isAgentEngine(engine)) return null;
  const Icon = ENGINE_ICONS[engine];
  return <Icon className={className} size={size} role="img" aria-label={`${engineLabel(engine)} thread`} />;
}
