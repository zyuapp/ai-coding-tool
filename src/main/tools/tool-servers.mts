import { AUTOMATION_SERVER } from "./automation.mjs";
import { BROWSER_SERVER } from "./browser.mjs";
import { COMPUTER_USE_SETUP_SERVER } from "./computer-use.mjs";
import { COORDINATION_SERVER } from "./coordination.mjs";
import { SIMULATOR_SERVER } from "./simulator.mjs";
import { TERMINAL_SERVER } from "./terminal.mjs";
import { THREAD_SERVER } from "./threads.mjs";

/** Every app tool server, in the order a run is offered them and told of them. */
export const TOOL_SERVERS = [
  COMPUTER_USE_SETUP_SERVER,
  AUTOMATION_SERVER,
  THREAD_SERVER,
  COORDINATION_SERVER,
  BROWSER_SERVER,
  SIMULATOR_SERVER,
  TERMINAL_SERVER,
] as const;

type Intersection<Union> = (Union extends unknown ? (part: Union) => void : never) extends (whole: infer Whole) => void ? Whole : never;

/** Everything of the run that any server binds to. */
export type ToolServerRun = Intersection<Parameters<(typeof TOOL_SERVERS)[number]["serve"]>[0]>;
