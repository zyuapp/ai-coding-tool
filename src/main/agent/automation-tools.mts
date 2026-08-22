import { createSdkMcpServer, tool, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { MAX_DETAIL, MAX_FINDING_KEY, MAX_HEADLINE } from "../../domain/task.js";
import { MAX_SURFACE_WHEN, type AutomationView } from "../../domain/automation.js";
import type { AutomationBridge, FindingBridge } from "./agent-provider.mjs";

export const AUTOMATION_SERVER_NAME = "claudex-automation";

const scheduleField = z.string().describe(
  "A five-field cron expression in local time (\"0 8 * * *\" = 8AM daily, \"* * * * *\" = every minute), or an ISO 8601 timestamp for a single run. Seconds are not supported.",
);

const policyField = z.enum(["confirm", "plan", "allow-edits", "autonomous"]).optional().describe(
  "Permission policy for scheduled runs. Nobody is watching when these fire, so anything that needs to act without a prompt should use \"autonomous\". Defaults to the task's own policy.",
);

const surfaceWhenField = z.string().max(MAX_SURFACE_WHEN).optional().describe(
  "One sentence naming when a tick of this schedule is worth the user's attention, such as \"an error in the logs was caused by the user's own code.\" Setting it makes the schedule quiet: a run that calls nothing_to_report settles without reaching anyone, and only one that calls notify surfaces. Leave it out and the schedule keeps whatever it surfaces for now, which for a new one is every run; pass an empty sentence to take the quiet off.",
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
    ...(automation.surfaceWhen ? [`surfaces when: ${automation.surfaceWhen}`] : []),
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

export function automationServer(bridge: AutomationBridge, findings?: FindingBridge): McpServerConfig {
  return createSdkMcpServer({
    name: AUTOMATION_SERVER_NAME,
    version: "1.0.0",
    alwaysLoad: true,
    tools: [...automationTools(bridge), ...(findings ? findingTools(findings) : [])],
  });
}

/**
 * What a quiet schedule uses to say whether this tick was worth the user's attention. Both are
 * stateless: they name nothing about the run, because the window is what knows which run is calling.
 */
export function findingTools(bridge: FindingBridge) {
  return [
    tool(
      "notify",
      "Surface this scheduled run to the user, saying what you found. Call it the moment you find something, not at the end: a run that is stopped afterwards keeps what it already raised. Call it once per finding; they accumulate. Nothing later retracts it, and a quiet run that never calls it settles without reaching anyone.",
      {
        headline: z.string().max(MAX_HEADLINE).describe("One line naming what you found. It is what the user reads in the sidebar, so write the finding itself rather than that you looked."),
        detail: z.string().max(MAX_DETAIL).optional().describe("The finding in full, in plain text: it lands in the thread under the headline, as written."),
        key: z.string().max(MAX_FINDING_KEY).optional().describe("What this finding is about, worded the same way on every run, so the same one is not raised twice while the user has yet to read it."),
      },
      async (args) => report(async () => {
        try {
          return (await bridge.notify(args)).note;
        } catch (error) {
          /** Whatever went wrong, the run has said it found something, and silence is no longer its to buy. */
          throw new Error(`${error instanceof Error ? error.message : String(error)} This run found something either way, so it must not call nothing_to_report.`);
        }
      }),
    ),
    tool(
      "nothing_to_report",
      "Say this run looked and found nothing worth surfacing, which is the only thing that lets a quiet scheduled run settle without disturbing the user. Say nothing at all and the run surfaces as an ordinary one, which is what a run that could not do its job should do.",
      { checked: z.string().max(MAX_HEADLINE).describe("What you actually checked, in a few words. A run that could not check what it came for has something to report, not nothing.") },
      async (args) => report(async () => (await bridge.nothingToReport(args.checked)).note),
    ),
  ];
}

export function automationTools(bridge: AutomationBridge) {
  return [
    tool(
      "schedule",
      "Turn this task into a recurring automation that re-runs a prompt on a schedule. Use when the user asks to repeat, babysit, poll, or watch something on a cadence. The task keeps one automation, so calling this again replaces it. Runs never overlap: a tick that arrives while the previous run is still going is dropped.",
      { prompt: promptField, schedule: scheduleField, timezone: z.string().optional().describe("IANA timezone such as \"America/Los_Angeles\". Defaults to the machine's local time."), policy: policyField, surfaceWhen: surfaceWhenField },
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
        surfaceWhen: surfaceWhenField,
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
