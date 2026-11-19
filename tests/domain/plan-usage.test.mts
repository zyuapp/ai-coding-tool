import assert from "node:assert/strict";
import { test } from "vitest";
import { usageWarningDismissed, usageWarningKey, withUsageWarningDismissed } from "../../src/domain/plan-usage.ts";

const window = (resetsAt: string, utilization = 85) => ({ id: "codex:primary", label: "Current session", utilization, resetsAt });

test("a dismissed warning stays away while its reset time drifts, and comes back once the window resets", () => {
  const dismissed = withUsageWarningDismissed([], usageWarningKey("codex", window("2026-11-19T11:42:01.000Z")));
  const drifted = usageWarningKey("codex", window("2026-11-19T11:42:18.000Z"));
  assert.equal(usageWarningDismissed(dismissed, drifted, Date.parse("2026-11-19T10:00:00Z")), true);
  assert.equal(usageWarningDismissed(dismissed, drifted, Date.parse("2026-11-19T11:42:02Z")), false);
  assert.equal(usageWarningDismissed(dismissed, usageWarningKey("codex", window("2026-11-19T11:42:18.000Z", 100)), Date.parse("2026-11-19T10:00:00Z")), false);
});
