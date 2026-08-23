---
name: update-critical-deps
description: Check the Claude Agent SDK and the Cua Driver for new releases, then apply and commit the ones that carry no breaking changes and report back on the ones that do.
disable-model-invocation: true
---

# Update critical dependencies

Two dependencies, three version surfaces in this repo:

- `@anthropic-ai/claude-agent-sdk` — the npm dependency. Call sites: `src/main/agent/claude-session.mts`, `src/main/agent/claude-agent-provider.mts`.
- `@trycua/cua-driver` — the npm dependency that provides the embedded host. Call site: `src/main/computer-use-host.ts`.
- The vendored Cua Driver binary — version and archive checksum pinned in `scripts/prepare-cua-driver.mts`. `npm run prepare:cua` re-downloads it whenever `vendor/cua-driver/version` no longer matches the pin.

The last two are one dependency in two places. Move them together or the embedded host talks to a binary it wasn't built against.

`~/.local/bin/cua-driver`, the standalone CLI, is a separate install and out of scope. Leave it alone unless asked.

## 1. Check

```
grep -n "claude-agent-sdk\|trycua" package.json
grep '"version"' node_modules/@anthropic-ai/claude-agent-sdk/package.json
npm view @anthropic-ai/claude-agent-sdk version
npm view @trycua/cua-driver version
grep -n "^const version" scripts/prepare-cua-driver.mts
```

Both current: say so, stop.

Ignore the `check_for_update` MCP tool here. It reports the standalone CLI's version from a 20h on-disk cache, not this repo's.

## 2. Analyse each new version for breaking changes

Both packages are pre-1.0, so a patch bump can still break. Never judge from the version number alone, and read before installing.

1. Read the release notes.
   - Cua Driver: `https://github.com/trycua/cua/releases/tag/cua-driver-rs-v<version>`
   - Agent SDK: releases on `anthropics/claude-agent-sdk-typescript`. Neither package ships a CHANGELOG.
2. Diff the type surface, which is the signal that doesn't lie. `npm pack <package>@<version>` into a temp dir, unpack, and diff its `.d.ts` files against the copy in `node_modules`. Pack rather than install so the tree stays untouched while you decide.
3. Read every hit against the repo's own call sites listed above.

Breaking means: an export the repo uses was removed, renamed, or retyped; a default changed in a way that changes behaviour; or a new required config or permission step.

**Breaking → stop.** Change nothing, and report which dependency, which version, what breaks, which call sites, and what the migration looks like. The decision to take it on is the user's.

**Clean → continue,** one dependency at a time.

## 3. Apply

Agent SDK:

```
npm install @anthropic-ai/claude-agent-sdk@<version>
```

Cua Driver — npm package and vendored binary in the same step:

```
npm install @trycua/cua-driver@<version>
curl -fsSL -o /tmp/cua.tgz https://github.com/trycua/cua/releases/download/cua-driver-rs-v<version>/cua-driver-rs-<version>-darwin-arm64.tar.gz
shasum -a 256 /tmp/cua.tgz
```

Write that version and hash into `version` and `expectedArchiveHash` in `scripts/prepare-cua-driver.mts`. The marker string derives from `version`, so it invalidates itself.

```
npm run prepare:cua
cat vendor/cua-driver/version
./vendor/cua-driver/cua-driver --version
```

`prepare:cua` throws on a checksum mismatch, so a quiet run means the hash matched.

## 4. Verify

`npm test`. If `tests/renderer.test.mts` needs isolation, re-run it with `npx vitest run tests/renderer.test.mts --testTimeout=30000` before calling it a failure.

## 5. Commit

One commit per dependency, staging only that dependency's files:

- Agent SDK: `package.json package-lock.json` → `Move the agent SDK to <version>`
- Cua Driver: `package.json package-lock.json scripts/prepare-cua-driver.mts` → `Move the Cua Driver to <version>`

Doing both means finishing and committing the SDK before touching the Cua Driver, since they share `package.json`.

`vendor/cua-driver/` is gitignored. The working tree usually carries unrelated in-flight edits — never stage them. Don't push unless asked.
