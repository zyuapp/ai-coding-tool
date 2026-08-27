/** Speaks enough of the app-server protocol over stdio for the client tests, with the `jsonrpc` field omitted as the real server does. */
import { createInterface } from "node:readline";

type Message = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };

const send = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);
const awaitingReply = new Map<number, (reply: unknown) => void>();
let initialized = false;
let nextServerId = 0;

function turn(message: Message) {
  const threadId = message.params?.threadId;
  const id = nextServerId++;
  send({ method: "turn/started", params: { threadId, turn: { id: "turn-1" } } });
  awaitingReply.set(id, (reply) => {
    send({ method: "turn/completed", params: { threadId, turn: { id: "turn-1", status: "completed", reply } } });
    send({ id: message.id, result: { turn: { id: "turn-1" } } });
  });
  send({ method: "item/commandExecution/requestApproval", id, params: { threadId, turnId: "turn-1", itemId: "item-1", command: "rm -rf build" } });
}

/** One response spread over three writes, larger than any pipe chunk, with a notification sharing its last write. */
function framed(message: Message) {
  const body = JSON.stringify({ id: message.id, result: { data: [{ id: "x".repeat(200_000) }], nextCursor: null } });
  const cut = Math.floor(body.length / 3);
  process.stdout.write(body.slice(0, cut));
  setTimeout(() => {
    process.stdout.write(body.slice(cut, 2 * cut));
    setTimeout(() => process.stdout.write(`${body.slice(2 * cut)}\n${JSON.stringify({ method: "warning", params: { message: "framed" } })}\n`), 10);
  }, 10);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message: Message = JSON.parse(line);
  if (message.id !== undefined && message.method === undefined) {
    awaitingReply.get(message.id)?.(message.result ?? message.error);
    return;
  }
  switch (message.method) {
    case "initialize":
      send({ id: message.id, result: { userAgent: `fake/${(message.params?.clientInfo as { name: string }).name}`, codexHome: "/tmp", platformFamily: "unix", platformOs: "macos" } });
      break;
    case "initialized":
      initialized = true;
      break;
    case "model/list":
      send({ id: message.id, result: { data: [], nextCursor: null, initialized } });
      break;
    case "thread/start":
      setTimeout(() => send({ id: message.id, result: { thread: { id: "thread-1" }, model: message.params?.model } }), 30);
      break;
    case "thread/read":
      send({ id: message.id, error: { code: -32600, message: "no such thread", data: { threadId: message.params?.threadId } } });
      break;
    case "turn/start":
      turn(message);
      break;
    case "thread/list":
      framed(message);
      break;
    case "account/logout":
      process.stderr.write("fatal: signed out\n", () => process.exit(3));
      break;
  }
});
process.on("SIGTERM", () => process.exit(0));
