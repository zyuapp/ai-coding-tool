import { SideChat } from "./SideChat";
import { attachDroppedFiles, imageSources } from "../dropped-files";
import type { useTaskWorkspace } from "../task-workspace/useTaskWorkspace";
import type { Task } from "../../domain/task";

type Workspace = ReturnType<typeof useTaskWorkspace>;

/** The side chats the dock holds as tabs of their own, each drawn from the workspace's own records. */
export function DockSideChats({ workspace, source, activeTab, focusTokenFor, onClose }: {
  workspace: Workspace;
  source: Task;
  activeTab: string;
  focusTokenFor: (tab: string) => number;
  onClose: (chatId: string) => void;
}) {
  return (
    <>
      {workspace.sideChats.map((chat) => (
        <div key={chat.id} hidden={activeTab !== chat.id}>
          <SideChat
            chat={chat}
            focusToken={focusTokenFor(chat.id)}
            source={source}
            project={workspace.currentProject}
            threads={workspace.threadHandlesFor(chat.id)}
            onPrompt={(prompt) => void workspace.dispatch({ type: "view.set-prompt", taskId: chat.id, prompt })}
            onAnnotateAdd={({ quote, note, anchor }) => void workspace.dispatch({ type: "annotation.add", taskId: chat.id, quote, note, anchor })}
            onAnnotateNote={(annotationId, note) => void workspace.dispatch({ type: "annotation.note", taskId: chat.id, annotationId, note })}
            onAnnotateRecall={(annotations) => void workspace.dispatch({ type: "annotation.recall", taskId: chat.id, annotations })}
            onAnnotateRemove={(annotationId) => void workspace.dispatch({ type: "annotation.remove", taskId: chat.id, annotationId })}
            onPasteAdd={(text) => void workspace.dispatch({ type: "paste.add", taskId: chat.id, text })}
            onPasteRecall={(pastes) => void workspace.dispatch({ type: "paste.recall", taskId: chat.id, pastes })}
            onPasteRemove={(pasteId) => void workspace.dispatch({ type: "paste.remove", taskId: chat.id, pasteId })}
            onFilesAdd={(files) => void attachDroppedFiles(files, chat.id, workspace.dispatch, imageSources(chat.images))}
            onFileRecall={(files) => void workspace.dispatch({ type: "file.recall", taskId: chat.id, files })}
            onFileRemove={(fileId) => void workspace.dispatch({ type: "file.detach", taskId: chat.id, fileId })}
            onImageRecall={(paths) => void workspace.dispatch({ type: "image.recall", taskId: chat.id, paths })}
            readingPoint={chat.readingPoint}
            onReadingPointMove={(point) => void workspace.dispatch({ type: "view.reading-point", taskId: chat.id, point })}
            onSend={(attachments, steer) => void workspace.dispatch({ type: "task.send", taskId: chat.id, attachments, steer })}
            onCancel={() => void workspace.dispatch({ type: "run.cancel", taskId: chat.id })}
            onDecide={(allow) => void workspace.dispatch({ type: "run.decide", allow, taskId: chat.id })}
            onPolicyChange={(policy) => void workspace.dispatch({ type: "task.set-policy", taskId: chat.id, policy })}
            onImageRemove={(imageId) => void workspace.dispatch({ type: "image.remove", taskId: chat.id, imageId })}
            onModelChange={(model) => void workspace.dispatch({ type: "task.set-model", taskId: chat.id, model })}
            onEffortChange={(effort) => void workspace.dispatch({ type: "task.set-effort", taskId: chat.id, effort })}
            onSteerQueued={(messageId) => void workspace.dispatch({ type: "task.steer-queued", taskId: chat.id, messageId })}
            onDropQueued={(messageId) => void workspace.dispatch({ type: "task.drop-queued", taskId: chat.id, messageId })}
            onClose={() => onClose(chat.id)}
          />
        </div>
      ))}
    </>
  );
}
