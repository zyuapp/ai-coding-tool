import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { createServer, request } from "node:http";
import path from "node:path";
import type { MobilePairingOffer } from "../../domain/mobile.js";

/**
 * Answers a pairing code over a private Unix socket, for the command line beside a headless host,
 * which is on the same machine and has every right to ask.
 */
export async function servePairingSocket(socketPath: string, pair: () => Promise<MobilePairingOffer>): Promise<() => Promise<void>> {
  const directory = path.dirname(socketPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.uid !== process.getuid?.()) throw new Error("The pairing socket directory is not owned by this user.");
  await chmod(directory, 0o700);
  // Whoever serves holds the machine's one instance, so any previous socket is stale.
  await rm(socketPath, { force: true });
  const server = createServer((req, res) => {
    res.setHeader("cache-control", "no-store");
    if (req.method !== "POST" || req.url !== "/pair") {
      res.writeHead(404).end();
      return;
    }
    void pair().then((offer) => {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(offer));
    }, (error: unknown) => res.writeHead(503).end(error instanceof Error ? error.message : "The bridge is not ready."));
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

/** Asks the process serving on the socket for a pairing code. */
export function requestPairing(socketPath: string): Promise<MobilePairingOffer> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: "/pair", method: "POST", timeout: 3_000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > 16_384) req.destroy(new Error("Invalid pairing response."));
      });
      res.on("error", reject);
      res.on("end", () => {
        try {
          if (res.statusCode !== 200) throw new Error(body || "The bridge is not ready.");
          const offer = JSON.parse(body) as MobilePairingOffer;
          if (typeof offer.url !== "string" || !/^[0-9A-HJKMNP-TV-Z]+$/.test(offer.code)) throw new Error("Invalid pairing response.");
          resolve(offer);
        } catch (error) { reject(error); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("The bridge did not answer.")));
    req.on("error", reject);
    req.end();
  });
}
