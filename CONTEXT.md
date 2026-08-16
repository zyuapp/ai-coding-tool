# Threadline

Threadline organizes local coding conversations and the attempts a coding agent makes to carry them out.

## Language

**Project**:
A saved local folder shown in the sidebar. A Project does not have to be a Git repository.
_Avoid_: Repository, workspace

**Workspace**:
The canonical filesystem scope used for one Run. It is either a Project root or Threadline's projectless scratch folder.
_Avoid_: Current directory, cwd

**Task**:
A persisted conversation with a title, messages, execution preference, and optional Project.
_Avoid_: Chat, thread, session

**Run**:
One attempt by a coding agent to respond to a prompt for a Task.
_Avoid_: Query, request, job

**Continuation**:
An opaque coding-agent reference that allows a later Run to resume prior provider context.
_Avoid_: Claude session, session ID

**Tool intent**:
A coding agent's proposed action before Threadline policy decides whether to deny it, allow it, or request Approval.
_Avoid_: Tool call, permission callback

**Approval**:
A pending user decision for one Tool intent in one Run.
_Avoid_: Permission card, confirmation

**Change snapshot**:
A read-only list of files reported as changed for a Project after a Run.
_Avoid_: Diff, working tree

**Coding agent**:
The external technology that executes Runs and streams their results. Claude is the current coding agent.
_Avoid_: Provider, SDK, claw
