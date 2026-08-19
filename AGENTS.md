# How we work
- We are the sole owners of the codebase. No need to make branches for any changes. We are allowed to make quick changes and push them directly to the main branch.
- I often ask you to make multiple changes on the main branch in different thread so only commit the changes that are requested in the thread.

# Architecture intent

The app has one control path for people and agents.
- Every interaction is an `AppCommand`.
- `reduce(state, input)` is the only writer of workspace state.
- The reducer describes external work as effects.
- `useTaskWorkspace` performs effects and returns results as `WorkspaceEvent` values.
- Components display state and dispatch commands. They contain no behaviour.
- External commands must pass validation before they reach the reducer.

## Add a feature
1. Define an `AppCommand` or `WorkspaceEvent`.
2. Handle it in the reducer.
3. Return an effect for external work.
4. Run the effect in `useTaskWorkspace`.
5. Return the result as a `WorkspaceEvent`.
6. Test the behaviour in `tests/workspace-reducer.test.mjs`.
7. Add an `actions` shorthand only when a component needs it.

If the reducer cannot express a UI action, an agent cannot perform it.

## Reach the workspace from a run
The window is the only holder of workspace state, so a run reaches it through the thread request
channel: `claudex-threads` tool → `ThreadChannel` → main relay → `useTaskWorkspace`. Reads answer
from the projections in `thread-projection.ts`, never raw state. Writes are `AppCommand` values on
the `ExternalCommand` surface, checked by `isThreadRequest` before they reach the reducer. Widen
that surface by naming the command in `ExternalCommand` and its guard, and expose it as a tool;
a command that no tool calls does not belong there.

## Where a thread works
A thread runs in its project checkout until it is given a worktree of its own. `Task.worktree`
records that checkout, so nothing else about the thread changes: it keeps its project, its place in
the sidebar, and its transcript. `resolveWorkspaceEffect` is the only place that decides which
checkout a run happens in, and `taskWorkspaceId` is the only place the panel and the environment
read it from.

Asking for a worktree moves the thread there and then, carrying its uncommitted work across; a
thread yet to exist is the only one that waits, since its checkout is made by its first message.
Worktrees are detached at whatever the project has checked out and never get a branch; the thread
makes one itself if it wants one. Switching back always removes the directory, and only work that
would otherwise be lost is worth stopping for: a worktree holding uncommitted changes is
force-committed first and kept reachable under `refs/claudex`, and a clean one just goes.

A worktree belongs to exactly one thread, and a thread is the only thing that keeps one alive. On
every start `reconcileWorktrees` reaps the checkouts under the worktrees root that no task claims —
snapshotting whatever they still hold first — and takes the claim away from a task whose checkout is
gone. Nothing else needs an eviction rule, and no cleanup path is reachable only through the UI.

Where a project lives is the picker's to say. A run may fill in a workspace a project does not have
yet, for the same folder, and may never move one: a project root inside the app's own worktrees is
refused at the database, not recorded.

Only `git.mts` runs git, and only `WorktreeService` creates, releases, or deletes a checkout.

## Side chats
A side chat is an ordinary task that is never saved and never listed. `state.sideChats` only records
which task ids are forks and where they came from; the thread itself lives in `state.tasks`, so every
task command — send, queue, steer, cancel, approve, change the model — reaches it with the chat id as
its `taskId`. The renderer shares one `TaskComposer`, given `surface="side"`.

Do not add a `side-chat.*` command for something a task command already does, and do not fork the
composer. A feature added to the main thread should reach a side chat without being written twice.

`WITHHELD_BY_CHANNEL` in `src/main/agent/channel-tools.mts` is the only place a tool is granted or
withheld by surface. A side chat reaches everything the main channel does except automation writes,
because it must not leave a schedule behind. Change what a surface can do by editing that table, and
grant a write there only if closing the chat also undoes it.

## Add a right panel view
Every view in the right panel is a closable tab. Add one `DockPanel` entry to `dockPanels` in `App.tsx`; the tab strip, the picker, the add menu, and the content region all derive from that entry. Do not render a right panel view outside the registry.

## Colour
`src/renderer/styles.css` draws every colour from a token in the `:root` block at the top of the
file. A rule names a token and never writes a hex, an `rgb()`, or a named colour. A theme is a second
block that redefines the same names, so a literal in a rule is a hole a theme cannot reach.

Take an existing token before adding one. They cover surfaces, lines, a ten-step text ladder from
`--ink` to `--quiet-soft`, the accent, info, success, danger, and alert families, and the shadows and
scrims. A new token is named for the role it plays, not the colour it currently holds.

Components carry a class, never a colour: the only inline styles are geometry a stylesheet cannot
know. Colour outside the stylesheet follows the tokens too — the window background in `main.ts`
tracks `--canvas`, and Mermaid reads the root `color-scheme` rather than naming a theme.
