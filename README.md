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
- File-edit enforcement inside the selected project folder

## Checks

```bash
npm run check
npm test
```

The current build is a development app, not a signed installer.
