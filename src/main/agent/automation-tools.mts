import { createSdkMcpServer, tool, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AutomationView } from "../../domain/automation.js";
import type { AutomationBridge } from "./agent-provider.mjs";

export const AUTOMATION_SERVER_NAME = "claudex-automation";

const scheduleField = z.string().describe(
  "A five-field cron expression in local time (\"0 8 * * *\" = 8AM daily, \"* * * * *\" = every minute), or an ISO 8601 timestamp for a single run. Seconds are not supported.",
);

const policyField = z.enum(["confirm", "plan", "allow-edits", "autonomous"]).optional().describe(
  "Permission policy for scheduled runs. Nobody is watching when these fire, so anything that needs to act without a prompt should use \"autonomous\". Defaults to the task's own policy.",
);

const promptField = z.string().describe(
  "The prompt to run on every tick. Write it to stand alone, and state the stop condition inside it so the scheduled run knows when to call stop.",
);

function describe(automation: AutomationView) {
  const lines = [
    `schedule: ${automation.schedule}${automation.timezone ? ` (${automation.timezone})` : ""}`,
    `paused: ${automation.paused}`,
    `runs so far: ${automation.runCount}`,
    `next run: ${automation.nextRunAt ? new Date(automation.nextRunAt).toISOString() : "none"}`,
    `last run: ${automation.lastRunAt ? `${new Date(automation.lastRunAt).toISOString()} (${automation.lastStatus})` : "never"}`,
    ...(automation.policy ? [`policy: ${automation.policy}`] : []),
    `prompt: ${automation.prompt}`,
  ];
  return lines.join("\n");
}

async function report(work: () => Promise<string>) {
  try {
    return { content: [{ type: "text" as const, text: await work() }] };
  } catch (error) {
    return { content: [{ type: "text" as const, text: `Automation error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function automationServer(bridge: AutomationBridge): McpServerConfig {
  return createSdkMcpServer({
    name: AUTOMATION_SERVER_NAME,
    version: "1.0.0",
    alwaysLoad: true,
    tools: automationTools(bridge),
  });
}

export function automationTools(bridge: AutomationBridge) {
  return [
    tool(
      "schedule",
      "Turn this task into a recurring automation that re-runs a prompt on a schedule. Use when the user asks to repeat, babysit, poll, or watch something on a cadence. The task keeps one automation, so calling this again replaces it. Runs never overlap: a tick that arrives while the previous run is still going is dropped.",
      { prompt: promptField, schedule: scheduleField, timezone: z.string().optional().describe("IANA timezone such as \"America/Los_Angeles\". Defaults to the machine's local time."), policy: policyField },
      async (args) => report(async () => `Automation scheduled.\n${describe(await bridge.save(args))}`),
    ),
    tool(
      "status",
      "Read this task's automation: schedule, next run, how many times it has run, and its prompt.",
      {},
      async () => report(async () => {
        const automation = await bridge.read();
        return automation ? describe(automation) : "This task has no automation.";
      }),
    ),
    tool(
      "update",
      "Change this task's existing automation without recreating it. Pass only the fields that change. Pause instead of stopping when the user wants to keep the automation around.",
      {
        prompt: promptField.optional(),
        schedule: scheduleField.optional(),
        timezone: z.string().optional().describe("IANA timezone for the schedule."),
        policy: policyField,
        paused: z.boolean().optional().describe("Pause or resume without discarding the automation."),
      },
      async (args) => report(async () => `Automation updated.\n${describe(await bridge.update(args))}`),
    ),
    tool(
      "stop",
      "Delete this task's automation so it stops firing. Call this from inside a scheduled run the moment its stop condition is met — nothing else ends an automation, so skipping this leaves it running forever.",
      {},
      async () => report(async () => (await bridge.remove()) ? "Automation stopped and removed." : "This task has no automation."),
    ),
    tool(
      "list_all",
      "List every automation across all tasks, not just this one.",
      {},
      async () => report(async () => {
        const automations = await bridge.list();
        if (!automations.length) return "No automations exist.";
        return automations.map((automation) => `task ${automation.taskId}\n${describe(automation)}`).join("\n\n");
      }),
    ),
  ];
}
