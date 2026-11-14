import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { registerSessionProcess } from "../agent/session-resources.mjs";

/** Drain stderr and deliver exit after its bounded drain, as the SDK's local spawner does. */
export function spawnClaudeProcess(options: SpawnOptions, stderr: (text: string) => void): SpawnedProcess {
  const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], signal: options.signal });
  registerSessionProcess(child);
  const events = new EventEmitter();
  let ended = false;
  let drained = false;
  let exit: [number | null, NodeJS.Signals | null] | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = () => {
    if (ended || !exit) return;
    ended = true;
    clearTimeout(timer);
    events.emit("exit", ...exit);
    child.stderr.destroy();
  };
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => { if (!ended) stderr(text); });
  child.stderr.on("error", () => {});
  child.stderr.once("close", () => { drained = true; finish(); });
  child.once("exit", (code, signal) => {
    exit = [code, signal];
    if (drained) finish(); else { timer = setTimeout(finish, 200); timer.unref(); }
  });
  child.on("error", error => events.emit("error", error));
  return {
    stdin: child.stdin, stdout: child.stdout,
    get killed() { return child.killed; },
    get exitCode() { return child.exitCode; },
    get signalCode() { return child.signalCode; },
    kill: signal => child.kill(signal),
    on: (event, listener) => { events.on(event, listener); },
    once: (event, listener) => { events.once(event, listener); },
    off: (event, listener) => { events.off(event, listener); },
  };
}
