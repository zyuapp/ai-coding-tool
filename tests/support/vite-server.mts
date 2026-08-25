import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type InlineConfig, type ViteDevServer } from "vite";

/**
 * A Vite server that shares no state with the servers other test files build. Vite commits its
 * optimized dependencies by deleting the cache folder and renaming a temporary one over it, and
 * test files run in parallel processes, so servers on one `node_modules/.vite` deleted the folder
 * out from under each other and failed with `ENOTEMPTY: directory not empty, rmdir`.
 */
export async function isolatedViteServer(config: InlineConfig): Promise<{ vite: ViteDevServer; close: () => Promise<void> }> {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), "aicodingtool-vite-"));
  let vite: ViteDevServer;
  try {
    /**
     * These servers only run modules; nothing here serves a browser. Discovery pre-bundled anyway,
     * and the folder it was still writing into raced the removal of the cache below.
     */
    vite = await createServer({ ...config, cacheDir, optimizeDeps: { noDiscovery: true, include: [] } });
  } catch (cause) {
    await rm(cacheDir, { recursive: true, force: true });
    throw cause;
  }
  return {
    vite,
    close: async () => {
      await vite.close();
      await rm(cacheDir, { recursive: true, force: true });
    },
  };
}
