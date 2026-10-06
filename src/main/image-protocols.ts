import { protocol } from "electron";
import { ATTACHMENT_SCHEME } from "../application/attachments.js";
import { MESSAGE_IMAGE_SCHEME } from "../domain/message-artifacts.js";
import { VISUAL_SCHEME } from "../domain/visual-frame.js";
import { attachmentResponse } from "./attachment-response.js";
import type { ComputerReads } from "./computer-queries.js";
import { messageImageResponse } from "./message-image-response.js";

/** Electron takes every scheme once, before readiness; their handlers come after the host starts. */
export function registerAppSchemes() {
  protocol.registerSchemesAsPrivileged([
    { scheme: ATTACHMENT_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
    { scheme: MESSAGE_IMAGE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
    { scheme: VISUAL_SCHEME, privileges: { standard: true, secure: true } },
  ]);
}

export function handleImageProtocols(reads: Pick<ComputerReads, "read">) {
  protocol.handle(ATTACHMENT_SCHEME, (request) => attachmentResponse(request.url, reads));
  protocol.handle(MESSAGE_IMAGE_SCHEME, (request) => messageImageResponse(request.url, reads));
}
