import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { BoundTool } from "./tool-definition.mjs";

/** What a served set is reachable as: the address, and the bearer token that names the set. */
export type ServedTools = {
  url: string;
  token: string;
  /** Forgets the token and drops every connection made with it. */
  release(): void;
};

export type ToolHost = {
  serve(tools: readonly BoundTool[]): Promise<ServedTools>;
};

type Registration = {
  tools: readonly BoundTool[];
  /** Live MCP sessions opened with the token, by the id the transport gave each. */
  sessions: Map<string, StreamableHTTPServerTransport>;
};

const SERVER_INFO = { name: "aicodingtool", version: "1.0.0" };
const PATH = "/mcp";

function bearerOf(header: string | undefined) {
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
}

function first(header: string | string[] | undefined) {
  return Array.isArray(header) ? header[0] : header;
}

function mcpServer(tools: readonly BoundTool[]) {
  const server = new McpServer(SERVER_INFO);
  for (const bound of tools) {
    server.registerTool(bound.name, { description: bound.description, inputSchema: bound.input }, (args) => bound.handler(args));
  }
  return server;
}

/**
 * Serves the app's tools over streamable HTTP on the loopback interface, to any MCP client that can
 * carry a bearer token. Each token names one set of tools, so a caller sees exactly the set it was
 * given and nobody else's. The listener opens on the first set served, on a port of the system's choosing.
 */
export class McpHttpHost implements ToolHost {
  private readonly registrations = new Map<string, Registration>();
  private server: Server | null = null;
  private listening: Promise<string> | null = null;

  async serve(tools: readonly BoundTool[]): Promise<ServedTools> {
    const url = await (this.listening ??= this.listen());
    const token = randomUUID();
    const registration: Registration = { tools, sessions: new Map() };
    this.registrations.set(token, registration);
    return {
      url,
      token,
      release: () => {
        if (!this.registrations.delete(token)) return;
        for (const transport of registration.sessions.values()) void transport.close();
      },
    };
  }

  async close() {
    for (const registration of this.registrations.values()) {
      for (const transport of registration.sessions.values()) void transport.close();
    }
    this.registrations.clear();
    const server = this.server;
    this.server = null;
    this.listening = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private async listen() {
    const server = createServer((request, response) => void this.handle(request, response));
    this.server = server;
    try {
      return await new Promise<string>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("The tool service has no port."));
            return;
          }
          resolve(`http://127.0.0.1:${address.port}${PATH}`);
        });
      });
    } catch (error) {
      /** A listener that never opened is forgotten, so the next set served tries afresh. */
      server.close();
      if (this.server === server) {
        this.server = null;
        this.listening = null;
      }
      throw error;
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    const token = bearerOf(request.headers.authorization);
    const registration = token === undefined ? undefined : this.registrations.get(token);
    if (!registration) {
      response.writeHead(401).end();
      return;
    }
    const sessionId = first(request.headers["mcp-session-id"]);
    let transport = sessionId === undefined ? undefined : registration.sessions.get(sessionId);
    if (!transport) {
      /** Only a fresh POST may open a session; a stale or foreign session id names nothing here. */
      if (sessionId !== undefined || request.method !== "POST") {
        response.writeHead(404).end();
        return;
      }
      const opened = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { registration.sessions.set(id, opened); },
      });
      opened.onclose = () => {
        if (opened.sessionId !== undefined && registration.sessions.get(opened.sessionId) === opened) registration.sessions.delete(opened.sessionId);
      };
      await mcpServer(registration.tools).connect(opened);
      transport = opened;
    }
    try {
      await transport.handleRequest(request, response);
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  }
}
