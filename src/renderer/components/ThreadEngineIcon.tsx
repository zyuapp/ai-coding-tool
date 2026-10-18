import type { IconType } from "react-icons";
import { BsClaude, BsOpenai } from "react-icons/bs";
import { LuMessageSquare as MessageSquare } from "react-icons/lu";
import { engineLabel, isAgentEngine, type AgentEngine } from "../../domain/agent-engine";

const ENGINE_ICONS: Record<AgentEngine, IconType> = {
  claude: BsClaude,
  codex: BsOpenai,
};

/** A thread's provider mark, or a plain thread's for an engine this build does not know. */
export function engineIcon(engine: AgentEngine): IconType {
  return isAgentEngine(engine) ? ENGINE_ICONS[engine] : MessageSquare;
}

/** A thread's provider mark stays compact enough to sit beside its other identity marks. An engine this build does not know draws none. */
export function ThreadEngineIcon({ engine, className, size }: { engine: AgentEngine; className?: string; size: number }) {
  if (!isAgentEngine(engine)) return null;
  const Icon = ENGINE_ICONS[engine];
  return <Icon className={className} size={size} aria-label={`${engineLabel(engine)} thread`} />;
}
