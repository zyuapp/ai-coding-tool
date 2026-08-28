import { Hexagon, type LucideIcon } from "lucide-react";
import { engineLabel, type AgentEngine } from "../../domain/agent-engine";

/** Only an engine other than the default is marked; a Claude thread carries no glyph. */
const GLYPHS: Partial<Record<AgentEngine, LucideIcon>> = { codex: Hexagon };

/** Whether a thread on the engine carries a glyph at all, so a row can leave the default engine unmarked. */
export function hasEngineGlyph(engine: AgentEngine) {
  return GLYPHS[engine] !== undefined;
}

export function EngineGlyph({ engine, size = 13, className = "" }: { engine: AgentEngine; size?: number; className?: string }) {
  const Icon = GLYPHS[engine];
  if (!Icon) return null;
  return <Icon className={`engine-glyph ${className}`.trim()} size={size} aria-label={`Runs on ${engineLabel(engine)}`} />;
}
