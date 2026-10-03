import { protocol } from "electron";
import { ATTACHMENT_SCHEME } from "../application/attachments.js";
import { MESSAGE_IMAGE_SCHEME } from "../domain/message-artifacts.js";
import { attachmentResponse } from "./attachment-response.js";
import type { ComputerReads } from "./computer-queries.js";
import { messageImageResponse } from "./message-image-response.js";

/** Electron needs the image schemes before readiness, and their handlers after the host starts. */
export function registerImageSchemes() {
  protocol.registerSchemesAsPrivileged([
    { scheme: ATTACHMENT_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
    { scheme: MESSAGE_IMAGE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

export function handleImageProtocols(reads: Pick<ComputerReads, "read">) {
  protocol.handle(ATTACHMENT_SCHEME, (request) => attachmentResponse(request.url, reads));
  protocol.handle(MESSAGE_IMAGE_SCHEME, (request) => messageImageResponse(request.url, reads));
}
