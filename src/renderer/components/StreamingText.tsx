import { useRef } from "react";
import { emptyScan, repairCut, scanBlocks } from "../../domain/markdown-stream";
import { MarkdownMessage } from "./MarkdownMessage";

/** Streamed text only ever grows, so the block scan resumes rather than re-reading from the start. */
function useCompleteBlocks(text: string) {
  const scan = useRef(emptyScan());
  const seen = useRef("");
  if (!text.startsWith(seen.current)) scan.current = emptyScan();
  scan.current = scanBlocks(text, scan.current);
  seen.current = text;
  return scan.current.safeEnd;
}

/**
 * The committed part is whole Markdown blocks; the live part is the block still being written, whose
 * cut is repaired so half-written markup is held back rather than shown as literal markers. Words in
 * the live part fade in as they mount. `streaming` says more text may still arrive.
 */
export function StreamingText({ committed, tail = "", streaming = false }: {
  committed: string;
  tail?: string;
  streaming?: boolean;
}) {
  const full = committed + tail;
  const blocks = useCompleteBlocks(full);
  /** Nothing more is coming, so the whole answer renders as one document. */
  if (!streaming) return <MarkdownMessage>{full}</MarkdownMessage>;
  const settled = full.slice(0, blocks);
  const live = repairCut(full.slice(blocks));
  return (
    <>
      {settled && <MarkdownMessage>{settled}</MarkdownMessage>}
      {live && <MarkdownMessage animate>{live}</MarkdownMessage>}
    </>
  );
}
