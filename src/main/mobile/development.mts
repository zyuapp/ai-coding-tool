import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, realpath, rm } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MobilePairingOffer } from "../../domain/mobile.js";

/** Both source processes know the checkout. A private Unix socket lets the launcher ask for a
 * normal pairing code without publishing a bootstrap secret or a browser-accessible endpoint. */
export async function developmentSocket(root: string): Promise<string> {
  const checkout = await realpath(root);
  const key = createHash("sha256").update(`${process.getuid?.()}:${checkout}`).digest("hex").slice(0, 12);
  return path.join(tmpdir(), `aic-mobile-${key}`, "pair.sock");
}

export async function serveDevelopmentPairing(root: string, pair: () => Promise<MobilePairingOffer>): Promise<() => Promise<void>> {
  const socketPath = await developmentSocket(root);
  const directory = path.dirname(socketPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.uid !== process.getuid?.()) throw new Error("The mobile development socket directory is not owned by this user.");
  await chmod(directory, 0o700);
  // The desktop's single-instance lock is held before this starts; any previous socket is stale.
  await rm(socketPath, { force: true });
  const server = createServer((req, res) => {
    res.setHeader("cache-control", "no-store");
    if (req.method !== "POST" || req.url !== "/pair") {
      res.writeHead(404).end();
      return;
    }
    void pair().then((offer) => {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(offer));
    }, () => res.writeHead(503).end("The desktop mobile bridge is not ready."));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { server.off("error", reject); resolve(); });
  });
  return async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    await rm(socketPath, { force: true });
  };
}

/** Runs in the Vite process, never in the page. */
export async function requestDevelopmentPairing(root: string): Promise<MobilePairingOffer> {
  const socketPath = await developmentSocket(root);
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: "/pair", method: "POST", timeout: 3_000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > 16_384) req.destroy(new Error("Invalid development pairing response."));
      });
      res.on("error", reject);
      res.on("end", () => {
        try {
          if (res.statusCode !== 200) throw new Error("The desktop mobile bridge is not ready.");
          const offer = JSON.parse(body) as MobilePairingOffer;
          const url = new URL(offer.url);
          if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !/^[0-9A-HJKMNP-TV-Z]+$/.test(offer.code)) {
            throw new Error("Invalid development pairing response.");
          }
          resolve(offer);
        } catch (error) { reject(error); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("The desktop mobile bridge did not answer.")));
    req.on("error", reject);
    req.end();
  });
}
