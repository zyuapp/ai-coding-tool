import type { AttachedFileDraft } from "../domain/conversation.js";
import type { ImageDesktopAPI } from "./images.js";

/** Files dropped or pasted into the window, and the images kept for composers and replies. */
export type FilePort = {
  runtime: Pick<ImageDesktopAPI, "saveAttachment" | "preserveMessageImages" | "readMessageImage" | "downloadImage">;
  windowCalls: Pick<ImageDesktopAPI, "saveAttachment" | "readAttachment" | "readAttachmentContext"> & {
    /** What each of those paths is. A path that is neither a file nor a folder is left out. */
    describeFiles(paths: string[]): Promise<AttachedFileDraft[]>;
  };
  windowOwn: {
    /** Where a dropped or pasted file sits on this machine. Empty for anything that is not a file on disk. */
    pathForFile(file: File): string;
  };
};
