import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { listAcrossComputers, queryLocalThreads, readAcrossComputers } from "../../src/host/thread-reads.ts";
import { createRuntimeHistory } from "../../src/host/runtime-history.ts";
import { subscribeWorkspaceRuntime } from "../../src/host/runtime-subscriptions.ts";
import { noComputers } from "../../src/host/no-computers.ts";
import { fakeDesktop } from "../support/desktop-api.mts";
import { reduce } from "../../src/application/workspace-reducer.ts";
import type { PairedComputer } from "../../src/application/computers.ts";
import type { ComputerThreadQuery } from "../../src/contracts/computers.ts";
import type { WorkspaceState } from "../../src/application/workspace-state.ts";
import { threadTranscript } from "../../src/application/thread-projection.ts";
import { task, workspace } from "../application/workspace-reducer-fixtures.mts";

function fixture() {
  const remote = workspace({
    projects: [{ id: "remote-project", root: "/linux/app" }],
    threads: [task("remote-id", { projectId: "remote-project", title: "Remote work", updatedAt: 20, messages: [{ id: "message", kind: "assistant", text: "Experiment results", at: 20 }] })],
  });
  const computer: PairedComputer = { id: "linux", name: "Linux", host: "linux.test", pairedAt: 1, status: "connected", error: null, state: remote };
  const state = workspace({ threads: [task("caller", { updatedAt: 10 })] });
  state.computers = { ...state.computers, filter: "this", paired: [computer] };
  const queries: Array<{ id: string; query: ComputerThreadQuery }> = [];
  const host = {
    state: () => state,
    desktop: { queryComputerThreads: async (id: string, query: ComputerThreadQuery): Promise<unknown> => {
      queries.push({ id, query });
      return queryLocalThreads(() => remote, async () => {}, query);
    } },
  };
  return { state, remote, computer, queries, host };
}

test("a known remote ID reads only its owner's transcript, independently of the sidebar filter", async () => {
  const { host, queries, state } = fixture();
  const before = state.currentId;
  const transcript = await readAcrossComputers(host, "remote-id", 1);
  assert.equal(transcript.messages[0].text, "Experiment results");
  assert.deepEqual(transcript.thread.computer, { id: "linux", name: "Linux", offline: false });
  assert.deepEqual(queries, [{ id: "linux", query: { kind: "thread-read", threadId: "remote-id", limit: 1 } }]);
  assert.equal(state.currentId, before, "reading does not navigate the UI");
  await readAcrossComputers(host, "caller");
  assert.equal(queries.length, 1, "local reads never query a peer");
});

test("list defaults stay local; all computers merge by activity and apply a global limit", async () => {
  const { host, queries, state } = fixture();
  assert.deepEqual((await listAcrossComputers(host, "caller", {})).map((row) => row.id), ["caller"]);
  const rows = await listAcrossComputers(host, "caller", { computer: "all", limit: 1 });
  assert.deepEqual(rows.map((row) => row.id), ["remote-id"]);
  assert.equal(rows[0].computer?.id, "linux");
  assert.deepEqual(queries, [], "discovery reuses the mirrored index");
  assert.equal((await listAcrossComputers(host, "caller", { computer: "Linux", project: "app" }))[0].id, "remote-id");
  assert.deepEqual((await listAcrossComputers(host, "caller", { computer: "all", project: "app" })).map((row) => row.id), ["remote-id"], "a named project need not exist on every computer");
  assert.deepEqual(await listAcrossComputers(host, "caller", { computer: "all", limit: 0 }), []);
  state.computers.paired = [];
  assert.deepEqual((await listAcrossComputers(host, "caller", { computer: "all", project: "current" })).map((row) => row.id), ["caller"]);
});

test("offline hosts can be discovered from cached rows but transcripts and searches fail clearly", async () => {
  const { host, computer, queries } = fixture();
  computer.status = "offline";
  const rows = await listAcrossComputers(host, "caller", { computer: "all" });
  assert.equal(rows.find((row) => row.id === "remote-id")?.computer?.offline, true);
  await assert.rejects(readAcrossComputers(host, "remote-id"), /Linux is offline/);
  await assert.rejects(listAcrossComputers(host, "caller", { computer: "linux", search: "results" }), /Linux is offline/);
  await assert.rejects(readAcrossComputers(host, "missing"), /Linux is not connected/);
  assert.deepEqual(queries, []);
});

test("matching references require a computer, and an exact remote ID wins over a local title", async () => {
  const { state, host } = fixture();
  state.threads[0].title = "Remote work";
  await assert.rejects(readAcrossComputers(host, "Remote work"), /More than one computer/);
  assert.equal((await readAcrossComputers(host, "Remote work", 1, "linux")).thread.id, "remote-id");
  assert.equal((await readAcrossComputers(host, "Remote work", 1, "this")).thread.id, "caller");
  state.threads[0].title = "remote-id";
  assert.equal((await readAcrossComputers(host, "remote-id")).thread.id, "remote-id");
  await assert.rejects(readAcrossComputers(host, "caller", 1, "linux"), /No thread/);
  await assert.rejects(readAcrossComputers(host, "remote-id", 1, "unknown"), /No paired computer/);
});

test("reads diagnose missing snapshots and reject ambiguous computer labels", async () => {
  const { state, host, computer } = fixture();
  state.computers.paired.push({ ...computer, id: "another-linux" });
  await assert.rejects(readAcrossComputers(host, "remote-id", 1, "Linux"), /More than one computer is named/);
  state.computers.paired.pop();
  computer.state = null;
  await assert.rejects(readAcrossComputers(host, "remote-id"), /Linux is not connected/);
  await assert.rejects(listAcrossComputers(host, "caller", { computer: "linux" }), /has not sent its thread list yet/);
});

test("remote responses are validated and a wrong transcript cannot be substituted", async () => {
  const { host, remote } = fixture();
  for (const result of [null, {}, { ...threadTranscript(remote, "remote-id"), messages: [{ kind: "assistant", text: 42, at: 1 }] }, { ...threadTranscript(remote, "remote-id"), thread: { ...threadTranscript(remote, "remote-id")!.thread, id: "another" } }]) {
    host.desktop.queryComputerThreads = async () => result;
    await assert.rejects(readAcrossComputers(host, "remote-id"), /Invalid thread transcript/);
  }
  host.desktop.queryComputerThreads = async () => [{ id: "bad" }];
  await assert.rejects(listAcrossComputers(host, "caller", { computer: "linux", search: "results" }), /Invalid thread list/);
  host.desktop.queryComputerThreads = async () => { throw new Error("This feature is unavailable on that computer. Updating AI Coding Tool there may help."); };
  await assert.rejects(readAcrossComputers(host, "remote-id"), /Updating AI Coding Tool/);
});

function historyHost(initial: WorkspaceState) {
  let state = initial;
  const loads: string[] = [];
  const history = createRuntimeHistory({
    state: () => state,
    search: async (search, ids) => "needle in disk history".includes(search) ? ids : [],
    load: async (id) => { loads.push(id); return [{ id: "saved", kind: "assistant", text: "needle in disk history", at: 1 }]; },
    dispatch: async (input) => { state = reduce(state, input).state; },
    persistence: { persisted: null, pending: null, inFlight: null },
  });
  return { state: () => state, history, loads };
}

test("remote message searches read the owner's disk without loading it, and reads hydrate on the owner only", async () => {
  const { host, remote, state } = fixture();
  remote.threads[0] = { ...remote.threads[0], messages: [], historySummary: { messageCount: 1, attachmentCount: 0 } };
  const owner = historyHost(remote);
  host.desktop.queryComputerThreads = async (_id, query) => queryLocalThreads(owner.state, owner.history.prepareThreadRequest, query);
  const rows = await listAcrossComputers(host, "caller", { computer: "linux", search: "needle" });
  assert.equal(rows[0].id, "remote-id", "search includes content that was absent from the mirror");
  assert.deepEqual(owner.loads, []);
  assert.ok(owner.state().threads[0].historySummary);
  assert.deepEqual(await listAcrossComputers(host, "caller", { computer: "linux", search: "haystack" }), []);
  assert.equal((await readAcrossComputers(host, "remote-id")).messages[0].text, "needle in disk history");
  assert.deepEqual(owner.loads, ["remote-id"]);
  state.threads[0] = { ...state.threads[0], title: "remote-id", historySummary: { messageCount: 1, attachmentCount: 0 } };
  const caller = historyHost(state);
  await caller.history.prepareThreadRequest({ type: "thread.request", requestId: "read", taskId: "caller", op: "read", threadId: "remote-id" });
  assert.deepEqual(caller.loads, [], "an exact remote ID does not hydrate a local title match");
});

test("a local tool search answers from the stored history of an unloaded thread without loading it", async () => {
  const owner = historyHost(workspace({ threads: [task("caller"), task("cold", { title: "Old work", historySummary: { messageCount: 1, attachmentCount: 0 } })] }));
  const desktop = Object.assign(fakeDesktop(), noComputers);
  const subscription = subscribeWorkspaceRuntime({
    state: owner.state,
    dispatch: async () => {},
    execute: () => assert.fail("a list runs no command"),
    waiters: { current: [] },
    prepareThreadRequest: owner.history.prepareThreadRequest,
    desktop,
  });
  try {
    desktop.askThreads({ type: "thread.request", requestId: "search", taskId: "caller", op: "list", search: "needle" });
    await vi.waitFor(() => assert.equal(desktop.threadAnswers.length, 1));
    const answer = desktop.threadAnswers[0];
    if (!answer.ok) assert.fail(answer.message);
    assert.deepEqual((answer.result as Array<{ id: string }>).map((row) => row.id), ["cold"]);
    assert.deepEqual(owner.loads, []);
    assert.ok(owner.state().threads.find((thread) => thread.id === "cold")?.historySummary);
  } finally { subscription.stop(); }
});

test("paired queries stay local even if that host also has paired computers", async () => {
  const { state } = fixture();
  const holder = historyHost(state);
  await assert.rejects(queryLocalThreads(holder.state, holder.history.prepareThreadRequest, { kind: "thread-read", threadId: "remote-id" }), /No thread/);
  const rows = await queryLocalThreads(holder.state, holder.history.prepareThreadRequest, { kind: "thread-list" });
  assert.ok(Array.isArray(rows));
  assert.deepEqual(rows.map((row) => row.id), ["caller"]);
});
