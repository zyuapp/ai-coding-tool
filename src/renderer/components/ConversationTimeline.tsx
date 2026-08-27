import { elementScroll, useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, FolderSymlink, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { StreamingTail } from "../../application/task-workspace";
import type { FindView, ReadingPoint, ThreadWait } from "../../application/workspace-state";
import { DEFAULT_ENGINE } from "../../domain/agent-engine";
import type { Annotation, AnnotationAnchor, Task } from "../../domain/task";
import { groupTimeline, messageRows } from "../timeline/grouping";
import { MAX_FIND_HITS, targetKey } from "../../domain/find";
import { drawnMatches, paintMatches } from "../find/paint";
import { useAnnotationMarkers, useAnnotationSelection, useSelectionCapture } from "../timeline/use-annotations";
import { useReadingView } from "../timeline/use-reading-view";
import { AnnotatePopover, AnnotationMarkers, NoteEditor } from "./AnnotateLayer";
import { AttachmentViewer } from "./AttachmentViewer";
import { TimelineEmptyState } from "./TimelineEmptyState";
import { TimelineRow } from "./TimelineRow";
import { RevealedMessage } from "./TurnWork";

export { groupTimeline } from "../timeline/grouping";
export { formatElapsed } from "./TurnWork";
export { READING_SETTLE_MS } from "../timeline/use-reading-view";

const EMPTY_ANNOTATIONS: Annotation[] = [];

export type ConversationTimelineProps = {
  currentTask?: Task;
  /** What the engine running this thread is called. */
  engineLabel: string;
  folder: string;
  status: "idle" | "running" | "stopped";
  compacting: boolean;
  /** What the thread is waiting on before a run of its own can start, which can take minutes. */
  waitingOn?: ThreadWait | null;
  streamingTail?: StreamingTail | null;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  /** Where this thread was left reading, as the workspace holds it. Opening the thread puts it back. */
  readingPoint?: ReadingPoint;
  /** Reports where this thread's reader has settled, which the workspace keeps for the return trip. */
  onReadingPointMove?: (point: ReadingPoint) => void;
  empty?: { icon: LucideIcon; title: string; description: string };
  /** False while the stored threads are still on their way, when an empty transcript means nothing. */
  restored?: boolean;
  /** Shown under the empty state, where a thread that does not exist yet is set up. */
  startOptions?: ReactNode;
  /** The find bar, when it is this transcript being searched, and the match it is showing. */
  find?: FindView | null;
  /** This composer's drafted annotations, whose anchors are highlighted and numbered here. */
  annotations?: Annotation[];
  /** Offered on selected assistant text: annotate into this transcript's composer. */
  onAnnotateAdd?: (draft: { quote: string; note: string; anchor: AnnotationAnchor }) => void;
  onAnnotateNote?: (annotationId: string, note: string) => void;
  onAnnotateRemove?: (annotationId: string) => void;
  /** Offered next to it when this transcript can hand a selection to a side chat as a bare reference. */
  onAnnotateSide?: (quote: string) => void;
};

/** What each wait is called, in the thread the wait is happening in. */
const WAIT_LABELS: Record<ThreadWait, string> = {
  worktree: "Creating worktree…",
  "worktree-release": "Removing worktree…",
  run: "Starting…",
};

export function ConversationTimeline({ currentTask, engineLabel, folder, status, compacting, waitingOn = null, streamingTail, scrollContainerRef, readingPoint, onReadingPointMove, empty, restored = true, startOptions, find, annotations = EMPTY_ANNOTATIONS, onAnnotateAdd, onAnnotateNote, onAnnotateRemove, onAnnotateSide }: ConversationTimelineProps) {
  const messages = currentTask?.messages ?? [];
  const engine = currentTask?.engine ?? DEFAULT_ENGINE;
  const timelineRef = useRef<HTMLDivElement>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const annotate = useAnnotationSelection({ onAnnotateAdd, onAnnotateNote, onAnnotateRemove, onAnnotateSide });
  const lastMessage = messages.at(-1);
  /** The answer being read out, whether it is still streaming or has already finished. */
  const answerId = streamingTail?.messageId ?? (lastMessage?.kind === "assistant" ? lastMessage.id : undefined);
  const toolId = lastMessage?.kind === "tool" ? lastMessage.id : undefined;
  /** The gap above the timeline, which puts the virtualizer's offsets in the scroller's own terms. */
  const [scrollMargin, setScrollMargin] = useState(0);
  const groups = useMemo(
    () => groupTimeline(messages, { running: status === "running", tailMessageId: streamingTail?.messageId, runEndedAt: currentTask?.runEndedAt }),
    [messages, status, streamingTail?.messageId, currentTask?.runEndedAt],
  );
  /** Every scroll the virtualizer makes for itself passes through here, which is how the reading view knows it is not the reader's. */
  const virtualizerScrolledAt = useRef(-Infinity);
  const virtualizer = useVirtualizer({
    count: groups.length,
    getScrollElement: () => scrollContainerRef.current,
    scrollToFn: (offset, options, instance) => {
      virtualizerScrolledAt.current = performance.now();
      elementScroll(offset, options, instance);
    },
    estimateSize: (index) => {
      const group = groups[index];
      if (group?.kind === "turn") return group.final ? 140 : 64;
      return group?.message.kind === "user" ? 88 : 64;
    },
    getItemKey: (index) => groups[index]?.id ?? index,
    scrollMargin,
    overscan: 6,
  });
  const rowOfMessage = useMemo(() => messageRows(groups), [groups]);
  const hit = find?.hit ?? null;
  const rendered = virtualizer.getVirtualItems().map((item) => item.key).join(",");

  const painter = find ? targetKey(find.target) : "";

  /** Only what a message says is lit, so a match is never painted onto the chrome around it. */
  useEffect(() => {
    const needle = find?.query.trim().toLowerCase() ?? "";
    const found = drawnMatches(timelineRef.current, needle, "data-message-id", MAX_FIND_HITS);
    const active = hit ? found.find((match) => match.owner === hit.messageId && match.occurrence === hit.occurrence) : undefined;
    paintMatches(painter, found.map((match) => match.range), active?.range ?? null);
  }, [painter, find?.query, hit?.messageId, hit?.occurrence, rendered]);

  useEffect(() => () => paintMatches(painter, [], null), [painter]);

  const { atBottom, scrollToFoot } = useReadingView({
    scrollContainerRef, timelineRef, virtualizer, virtualizerScrolledAt, taskId: currentTask?.id, rowOfMessage,
    hit, answerId, toolId, readingPoint, onReadingPointMove, setScrollMargin,
  });
  useSelectionCapture({ timelineRef, scrollContainerRef, taskId: currentTask?.id, onAnnotateAdd, setSelection: annotate.setSelection, dismissNote: annotate.dismissNote });
  const markers = useAnnotationMarkers({ timelineRef, annotations, rendered, messageCount: messages.length });

  if (!currentTask?.messages.length && !streamingTail) {
    return <TimelineEmptyState restored={restored} engineLabel={engineLabel} folder={folder} empty={empty} startOptions={startOptions} />;
  }

  return (
    <RevealedMessage.Provider value={hit?.messageId ?? null}>
    <div className="timeline" ref={timelineRef}>
      <div className="timeline-items" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => (
          <TimelineRow
            key={item.key}
            engine={engine}
            group={groups[item.index]!}
            index={item.index}
            offset={item.start - scrollMargin}
            measure={virtualizer.measureElement}
            streamingTail={streamingTail}
            onViewAttachment={setViewing}
          />
        ))}
      </div>
      <AnnotationMarkers markers={markers} annotations={annotations} noteReturn={annotate.noteReturn} onEdit={annotate.setNoting} />
      {waitingOn && (
        <div className="waiting-row" role="status" aria-live="polite">
          <FolderSymlink aria-hidden="true" />
          <span className="text-sweep">{WAIT_LABELS[waitingOn]}</span>
        </div>
      )}
      {status === "running" && compacting && (
        <div className="compacting-row" role="status" aria-live="polite">
          <span className="text-sweep">Compacting messages…</span>
        </div>
      )}
      {status === "running" && !compacting && (
        <div className="thinking-row">
          <span /> <span /> <span />
        </div>
      )}
      {!atBottom && (
        <div className="scroll-to-end-dock">
        <button
          type="button"
          className="scroll-to-end"
          aria-label="Scroll to the latest message"
          onClick={scrollToFoot}
        >
          <ChevronDown size={17} aria-hidden="true" />
        </button>
        </div>
      )}
      {viewing && <AttachmentViewer source={viewing} onClose={() => setViewing(null)} />}
      {annotate.selection && !annotate.noting && onAnnotateAdd && (
        <AnnotatePopover
          selection={annotate.selection}
          toolbarRef={annotate.selectionToolbar}
          noteReturn={annotate.noteReturn}
          onNote={annotate.openNote}
          onSide={onAnnotateSide ? annotate.referToSide : undefined}
        />
      )}
      {annotate.noting && (
        <NoteEditor
          noting={annotate.noting}
          editorRef={annotate.noteEditor}
          onChange={annotate.setNoting}
          onCommit={annotate.commitNote}
          onClose={annotate.closeNote}
          onRemove={annotate.removeNote}
        />
      )}
    </div>
    </RevealedMessage.Provider>
  );
}
