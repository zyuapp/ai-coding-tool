import { fork } from "node:child_process";
import path from "node:path";
import type { StartAgentProcess } from "./agent-process.js";

/** Starts the agent process as a plain child of a host that has no Electron to fork it as a utility process. */
export function forkAgentProcessNode(options: { generatedImages: string; pluginPath: string }): StartAgentProcess {
  return (listener) => {
    const agent = fork(path.join(__dirname, "agent-worker.mjs"), [options.generatedImages, options.pluginPath], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      serialization: "advanced",
    });
    agent.on("message", (message: unknown) => listener.message(message));
    agent.on("exit", (code) => listener.exit(code));
    return {
      post: (message) => { agent.send(message); },
      kill: () => { agent.kill(); },
    };
  };
}
