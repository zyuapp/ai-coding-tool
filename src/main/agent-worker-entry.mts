import { persistCompileCache } from "./compile-cache.js";

/** The agent process starts here, so the worker and its SDKs load through the compile cache. */
await import("./agent-worker.mjs");
persistCompileCache();
