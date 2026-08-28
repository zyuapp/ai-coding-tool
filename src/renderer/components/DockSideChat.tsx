import { memo, useMemo, type ReactNode } from "react";
import { SideChat } from "./SideChat";
import { attachDroppedFiles, imageSources } from "../dropped-files";
import type { useTaskWorkspace } from "../task-workspace/useTaskWorkspace";
import type { AppCommand, ReadingPoint } from "../../contracts/commands";
import type { FindView, SideChatView } from "../../application/workspace-state";
import type { AgentEngine, AgentModel } from "../../domain/agent-engine";
import type { AgentEffort, ExecutionPolicy } from "../../domain/run";
import type { ThreadHandleOption } from "../../domain/thread-handles";
import type { Annotation, AnnotationAnchor, AttachedFile, PastedText, Project, RunAttachment, Task } from "../../domain/task";

type Workspace = ReturnType<typeof useTaskWorkspace>;
type Dispatch = (command: AppCommand) => Promise<void>;

/** Everything one chat's controls do, built once per chat so a redraw elsewhere never rebuilds them. */
function chatHandlers(dispatch: Dispatch, chatId: string, images: SideChatView["images"]) {
  return {
    onPrompt: (prompt: string) => void dispatch({ type: "view.set-prompt", taskId: chatId, prompt }),
    onAnnotateAdd: ({ quote, note, anchor }: { quote: string; note: string; anchor: AnnotationAnchor }) =>
      void dispatch({ type: "annotation.add", taskId: chatId, quote, note, anchor }),
    onAnnotateNote: (annotationId: string, note: string) => void dispatch({ type: "annotation.note", taskId: chatId, annotationId, note }),
    onAnnotateRecall: (annotations: Annotation[]) => void dispatch({ type: "annotation.recall", taskId: chatId, annotations }),
    onAnnotateRemove: (annotationId: string) => void dispatch({ type: "annotation.remove", taskId: chatId, annotationId }),
    onPasteAdd: (text: string) => void dispatch({ type: "paste.add", taskId: chatId, text }),
    onPasteRecall: (pastes: PastedText[]) => void dispatch({ type: "paste.recall", taskId: chatId, pastes }),
    onPasteRemove: (pasteId: string) => void dispatch({ type: "paste.remove", taskId: chatId, pasteId }),
    onFilesAdd: (files: File[]) => void attachDroppedFiles(files, chatId, dispatch, imageSources(images)),
    onFileRecall: (files: AttachedFile[]) => void dispatch({ type: "file.recall", taskId: chatId, files }),
    onFileRemove: (fileId: string) => void dispatch({ type: "file.detach", taskId: chatId, fileId }),
    onImageRecall: (paths: string[]) => void dispatch({ type: "image.recall", taskId: chatId, paths }),
    onImageRemove: (imageId: string) => void dispatch({ type: "image.remove", taskId: chatId, imageId }),
    onReadingPointMove: (point: ReadingPoint) => void dispatch({ type: "view.reading-point", taskId: chatId, point }),
    onSend: (attachments: RunAttachment[], steer: boolean) => void dispatch({ type: "task.send", taskId: chatId, attachments, steer }),
    onCancel: () => void dispatch({ type: "run.cancel", taskId: chatId }),
    onDecide: (allow: boolean) => void dispatch({ type: "run.decide", allow, taskId: chatId }),
    onPolicyChange: (policy: ExecutionPolicy) => void dispatch({ type: "task.set-policy", taskId: chatId, policy }),
    onModelChange: (engine: AgentEngine, model: AgentModel) => void dispatch({ type: "task.set-model", taskId: chatId, engine, model }),
    onEffortChange: (engine: AgentEngine, effort: AgentEffort) => void dispatch({ type: "task.set-effort", taskId: chatId, engine, effort }),
    onSteerQueued: (messageId: string) => void dispatch({ type: "task.steer-queued", taskId: chatId, messageId }),
    onDropQueued: (messageId: string) => void dispatch({ type: "task.drop-queued", taskId: chatId, messageId }),
  };
}

/**
 * One chat's tab. Memoized, and given only what the chat itself reads, so a run filling the main
 * thread with reports leaves it alone.
 */
const DockSideChatTab = memo(function DockSideChatTab({ chat, dispatch, engineLabel, sourceTitle, sourceContinued, project, threads, active, focusToken, find, findBar, onClose }: {
  chat: SideChatView;
  dispatch: Dispatch;
  engineLabel: string;
  sourceTitle: string;
  /** Whether the thread this chat forks has a session to fork, which is what it starts from. */
  sourceContinued: boolean;
  project: Project | undefined;
  threads: ThreadHandleOption[];
  active: boolean;
  focusToken: number;
  /** The bar, and the match it is showing, only when it is this chat's own thread being searched. */
  find: FindView | null;
  findBar: ReactNode;
  onClose: (chatId: string) => void;
}) {
  const handlers = useMemo(() => chatHandlers(dispatch, chat.id, chat.images), [dispatch, chat.id, chat.images]);
  const close = useMemo(() => () => onClose(chat.id), [onClose, chat.id]);
  return (
    <div data-dock-tab={chat.id} hidden={!active}>
      <SideChat
        chat={chat}
        engineLabel={engineLabel}
        focusToken={focusToken}
        find={find}
        findBar={findBar}
        sourceTitle={sourceTitle}
        sourceContinued={sourceContinued}
        {...(project ? { project } : {})}
        threads={threads}
        readingPoint={chat.readingPoint}
        {...handlers}
        onClose={close}
      />
    </div>
  );
});

/** The side chats the dock holds as tabs of their own, each drawn from the workspace's own records. */
export function DockSideChats({ workspace, source, activeTab, find, findBar, focusTokenFor, onClose }: {
  workspace: Workspace;
  source: Task;
  activeTab: string;
  find: FindView | null;
  findBar: ReactNode;
  focusTokenFor: (tab: string) => number;
  onClose: (chatId: string) => void;
}) {
  return (
    <>
      {workspace.sideChats.map((chat) => {
        /** Only the chat being searched is handed the bar, so the others are not redrawn by a query. */
        const searched = find?.target.kind === "thread" && find.target.taskId === chat.id ? find : null;
        return (
          <DockSideChatTab
            key={chat.id}
            chat={chat}
            dispatch={workspace.dispatch}
            engineLabel={workspace.engineLabel}
            sourceTitle={source.title}
            sourceContinued={Boolean(source.continuation)}
            project={workspace.currentProject}
            threads={workspace.threadHandlesFor(chat.id)}
            active={activeTab === chat.id}
            focusToken={focusTokenFor(chat.id)}
            find={searched}
            findBar={searched ? findBar : null}
            onClose={onClose}
          />
        );
      })}
    </>
  );
}
