import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce } from "../../src/application/workspace-reducer.ts";
import { routeInput } from "../../src/application/computers.ts";
import { isExternalCommand } from "../../src/contracts/ipc.ts";
import { isWorkspaceViewInput } from "../../src/contracts/workspace-view-input.ts";
import { effectOf, required, run, workspace } from "./workspace-reducer-fixtures.mts";

const BRAVE = { id: "brave:0:Default", browser: "Brave", profile: "Personal" };
const FIREFOX = { id: "firefox:0:Profiles/a", browser: "Firefox", profile: "default" };

function listed() {
  return run(workspace(), [{ type: "browser-import.sources", sources: [BRAVE, FIREFOX] }]);
}

test("settings reads the profiles, and choosing one reads its sites", () => {
  assert.deepEqual(reduce(workspace(), { type: "browser-import.read" }).effects, [{ type: "browser-import.list-sources" }]);

  const chosen = reduce(listed(), { type: "browser-import.choose", sourceId: BRAVE.id });
  assert.deepEqual(chosen.effects, [{ type: "browser-import.list-sites", sourceId: BRAVE.id }]);
  assert.equal(required(chosen.state.browserImport.picker).sites, null);

  const unknown = reduce(listed(), { type: "browser-import.choose", sourceId: "chrome:0:Default" });
  assert.equal(unknown.state.browserImport.picker, null, "only a profile that was found can be picked");
});

test("ticked sites are imported, remembered, and imported again on request", () => {
  const picked = run(listed(), [
    { type: "browser-import.choose", sourceId: BRAVE.id },
    { type: "browser-import.sites", sourceId: BRAVE.id, sites: [{ domain: "example.com", cookies: 2 }, { domain: "github.com", cookies: 5 }] },
    { type: "browser-import.toggle", site: "github.com" },
    { type: "browser-import.toggle", site: "not-offered.com" },
  ]);
  assert.deepEqual(required(picked.browserImport.picker).selected, ["github.com"]);

  const started = reduce(picked, { type: "browser-import.run" });
  assert.equal(started.state.browserImport.importing, true);
  assert.deepEqual(effectOf(started, "browser-import.import"), { type: "browser-import.import", sourceId: BRAVE.id, sites: ["github.com"] });
  assert.deepEqual(reduce(started.state, { type: "browser-import.run" }).effects, [], "one import at a time");

  const done = reduce(started.state, { type: "browser-import.done", sourceId: BRAVE.id, sites: ["github.com"], result: { imported: 5, skipped: 1 } });
  assert.equal(done.state.browserImport.picker, null);
  assert.equal(done.state.browserImport.notice, "Copied 5 cookies for github.com from Brave. 1 could not be read.");
  assert.deepEqual(done.state.browserImport.last, { sourceId: BRAVE.id, sites: ["github.com"] });
  assert.deepEqual(effectOf(done, "persist-preferences").preferences.browserImport, { sourceId: BRAVE.id, sites: ["github.com"] });

  const again = reduce(done.state, { type: "browser-import.again" });
  assert.deepEqual(effectOf(again, "browser-import.import"), { type: "browser-import.import", sourceId: BRAVE.id, sites: ["github.com"] });

  const reopened = run(done.state, [
    { type: "browser-import.choose", sourceId: BRAVE.id },
    { type: "browser-import.sites", sourceId: BRAVE.id, sites: [{ domain: "github.com", cookies: 5 }] },
  ]);
  assert.deepEqual(required(reopened.browserImport.picker).selected, ["github.com"], "the last import's sites start ticked");
});

test("a failure is shown beside the import, and an import that copied nothing is not remembered", () => {
  const reading = run(listed(), [{ type: "browser-import.choose", sourceId: FIREFOX.id }, { type: "browser-import.failed", message: "That browser profile is no longer on this computer." }]);
  assert.equal(reading.browserImport.picker, null);
  assert.equal(reading.browserImport.error, "That browser profile is no longer on this computer.");
  assert.equal(reading.actionError, null);

  const empty = run(listed(), [
    { type: "browser-import.choose", sourceId: BRAVE.id },
    { type: "browser-import.sites", sourceId: BRAVE.id, sites: [{ domain: "github.com", cookies: 5 }] },
    { type: "browser-import.toggle", site: "github.com" },
    { type: "browser-import.run" },
    { type: "browser-import.done", sourceId: BRAVE.id, sites: ["github.com"], result: { imported: 0, skipped: 5 } },
  ]);
  assert.equal(empty.browserImport.error, "No cookies could be copied from Brave.");
  assert.equal(empty.browserImport.last, null);
  assert.notEqual(empty.browserImport.picker, null, "the picks stay so the user can try again");
});

test("only the user imports, and the import stays on this computer", () => {
  assert.equal(isExternalCommand({ type: "browser-import.run" }), false);
  assert.equal(isExternalCommand({ type: "browser-import.again", taskId: "task-1" }), false);
  assert.equal(isWorkspaceViewInput({ type: "browser-import.toggle", site: "github.com" }), true);
  assert.equal(isWorkspaceViewInput({ type: "browser-import.toggle", site: "../etc" }), false);
  assert.deepEqual(routeInput(workspace(), { type: "browser-import.run" }), { kind: "local" });
});
