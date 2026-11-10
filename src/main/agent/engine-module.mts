import type { ToolHost } from "../tools/mcp-http-host.mjs";
import type { EngineProvider } from "./engine-router.mjs";
import type { EngineServices } from "./engine-services.mjs";
import type { SessionPool } from "./session-pool.mjs";

/** The command an engine is installed as, the npm package it is published as, and how to install it. */
export type EngineCommand = { command: string; packageName: string; install: string; isNative: (realPath: string) => boolean };

/** What every engine's provider is built with in a worker. */
export type ProviderContext = {
  /** Serves the app's tools to every session of the process. */
  host: ToolHost;
  /** The sessions a channel keeps warm, shared by its engines. */
  pool: SessionPool;
  /** Where images an engine generates are saved. */
  generatedImages?: string;
};

/** Everything the app knows of one engine. Each part loads the engine's own code when first used. */
export type EngineModule = {
  binary: EngineCommand;
  services: EngineServices;
  createProvider(context: ProviderContext): Promise<EngineProvider>;
};
