# Threadline

A small, local desktop client for running Claude coding tasks in a selected folder.

## Run

Prerequisites: Node.js 22+ and a Claude Code installation authenticated to a Claude subscription.

```bash
npm install
npm start
```

## Included in the MVP

- Local project picker
- Persistent task history and resumable Claude sessions
- Streamed responses and tool activity
- Manual, Plan, Accept edits, and Auto permission modes
- Allow/deny permission cards
- User and project Claude skills
- Stop control and Git changed-file summary
- Path-addressable file-edit enforcement inside the selected project folder

Shell commands are approved according to the selected permission mode, but are not OS-sandboxed to that folder.

## Architecture

- `src/domain`: provider-neutral Task, Run, and Workspace language
- `src/application`: storage and application policies
- `src/main/agent`: agent coordination and the Claude adapter
- `src/main/workspace`: Workspace registry, path policy, and Git adapter
- `src/renderer/components`: passive UI components
- `src/renderer/task-workspace`: renderer state and orchestration

## Checks

```bash
npm run check
npm test
```

The current build is a development app, not a signed installer.
