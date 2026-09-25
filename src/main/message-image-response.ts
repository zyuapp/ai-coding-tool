import { computerOfThread } from "../application/computers.js";
import type { WorkspaceState } from "../application/workspace-state.js";
import { isComputerQuery, type ComputerQuery } from "../contracts/computers.js";
import { messageImageBytes, messageImageResponse as localMessageImageResponse, preserveMessageImage } from "./message-image-store.js";

type MessageImageResponseHost = {
  state: () => WorkspaceState;
  query: (id: string, query: ComputerQuery) => Promise<unknown>;
};

/** Retain the holder's original once, for both previews and the full-size viewer. */
export async function messageImageResponse(source: string, host: MessageImageResponseHost): Promise<Response> {
  try {
    const params = new URL(source).searchParams;
    const query = { kind: "message-image", path: params.get("path"), root: params.get("root"), message: params.get("message") };
    if (!isComputerQuery(query) || query.kind !== "message-image") throw new Error("Invalid image reference.");
    const computer = computerOfThread(host.state(), params.get("taskId") ?? undefined);
    if (computer) {
      await preserveMessageImage(query.path, query.root, query.message, async () => messageImageBytes(await host.query(computer.id, query), query.path));
    }
    return await localMessageImageResponse(source);
  } catch {
    return new Response("Image unavailable", { status: 404 });
  }
}
