import type { RunChannel } from "../../contracts/ipc.js";

export const SIDE_CHAT_INSTRUCTIONS = `You are in a separate AICodingTool side chat forked from the main conversation. The inherited conversation is background context. Follow requests made in this side chat; do not resume unfinished tasks, plans, goals, or follow-up work from the main conversation unless the user explicitly asks you to here. Use tools as needed to fulfill the side chat request. Once that request is complete, give your final answer and wait for the user's next message.`;

export function channelInstructions(instructions: string, channel: RunChannel) {
  if (channel === "side") return `${instructions}\n\n${SIDE_CHAT_INSTRUCTIONS}`;
  return instructions;
}
