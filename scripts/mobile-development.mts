import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Plugin, ProxyOptions } from "vite";
import { requestDevelopmentPairing } from "../src/main/mobile/development.mts";

/** Serve the real phone entry, supplying its ordinary one-use code before React mounts. */
export function mobileDevelopment(root: string): Plugin {
  let socketProxy: ProxyOptions;
  return {
    name: "mobile-development",
    apply: "serve",
    config: () => ({
      server: {
        host: "127.0.0.1",
        cors: false,
        proxy: {
          "/m/socket": {
            // Replaced by the private desktop handshake before the page opens its socket.
            target: "http://127.0.0.1:9",
            ws: true,
            // Preserve Origin and Host so the mobile server can enforce its normal origin check.
            configure: (_proxy, options) => { socketProxy = options; },
          },
        },
      },
    }),
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const address = server.httpServer?.address();
        const port = address && typeof address === "object" ? address.port : server.config.server.port;
        const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
        const origin = req.headers.origin;
        if (!hosts.includes(req.headers.host ?? "") || (origin && origin !== `http://${req.headers.host}`) || req.headers["sec-fetch-site"] === "cross-site") {
          res.writeHead(403).end("This preview is available only from its local address.");
          return;
        }
        const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
        if (pathname === "/" || pathname === "/m" || pathname === "/index.mobile.html") {
          res.writeHead(302, { location: "/m/" }).end();
          return;
        }
        if (pathname !== "/m/") return next();
        if (req.method !== "GET") { res.writeHead(405).end(); return; }
        void (async () => {
          res.setHeader("cache-control", "no-store");
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.setHeader("content-security-policy", "frame-ancestors 'none'");
          res.setHeader("x-frame-options", "DENY");
          res.setHeader("referrer-policy", "no-referrer");
          let offer;
          try {
            offer = await requestDevelopmentPairing(root);
          } catch {
            res.statusCode = 503;
            res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mobile preview</title></head><body><p>Waiting for desktop app…</p><p>Run <code>npm start</code> in another terminal.</p><script>setTimeout(() => location.reload(), 1500)</script></body></html>`);
            return;
          }
          socketProxy.target = new URL(offer.url).origin;
          const source = await readFile(path.join(root, "index.mobile.html"), "utf8");
          const html = source
            .replace("__SCRIPT_HASHES__", "'self' 'unsafe-inline'")
            .replace("</head>", `<script>history.replaceState(null, "", "/m/#pair=" + ${JSON.stringify(offer.code)})</script></head>`);
          res.end(await server.transformIndexHtml("/index.mobile.html", html));
        })().catch(next);
      });
    },
  };
}
