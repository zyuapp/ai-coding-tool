/**
 * Compatibility facade for established Task imports. New domain code should import the owning
 * module and use Thread or ConversationMessage directly.
 */
export {
  MAX_ATTACHED_FILES,
  MAX_ATTACHMENTS,
  createConversationMessage as createTaskMessage,
  createFailureMessage,
  sentPrompts,
} from "./conversation.js";
export type {
  Annotation,
  AnnotationAnchor,
  AttachedFile,
  AttachedFileDraft,
  ConversationMessage as TaskMessage,
  ConversationMessageKind as TaskMessageKind,
  PastedText,
  RecalledMessage,
  RunAttachment,
  StagedImage,
} from "./conversation.js";

export { MAX_DETAIL, MAX_FINDING_KEY, MAX_FINDINGS, MAX_HANDLED_ISSUES, MAX_HEADLINE } from "./finding.js";
export type { AutomationFinding as TaskFinding } from "./finding.js";

export {
  findProject,
  folderName,
  isProject,
  legacyProjectId,
  projectName,
  sameRoot,
} from "./project.js";
export type { Project, ThreadDropTarget as TaskDropTarget } from "./project.js";

export type {
  ChangeSnapshot,
  ContextUsage,
  ContinuationStatus,
  ThreadOutcome as TaskOutcome,
} from "./thread-run.js";

export { clampTitle, forkTitle, threadActivityAt, threadCreatedAt } from "./thread.js";
export type { Thread, Thread as Task } from "./thread.js";

export { ARCHIVE_RETENTION_MS, retainedThreads as retainedTasks } from "./thread-retention.js";

export {
  THREAD_STORE_VERSION as TASK_STORE_VERSION,
  migrateV1ToV2,
  parseThreadStore as parseTaskStore,
  serializeThreadStore as serializeTaskStore,
  validateThreadStoreData as validateTaskStoreData,
} from "./thread-storage.js";
export type {
  SerializedThreadStore as SerializedTaskStore,
  StorageValues,
  StoredThread as StoredTask,
  ThreadStoreData as TaskStoreData,
  ThreadStoreParseResult as TaskStoreParseResult,
} from "./thread-storage.js";
