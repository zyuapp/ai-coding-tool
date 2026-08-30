---
name: update-critical-deps
description: Check the Claude Agent SDK, Codex, and the Cua Driver for new releases, then apply and commit the ones that carry no breaking changes and report back on the ones that do.
disable-model-invocation: true
---

# Update critical dependencies

Three dependencies touch several versioned files in this repo:

- `@anthropic-ai/claude-agent-sdk` is an npm dependency. Its call sites are `src/main/agent/claude-session.mts` and `src/main/agent/claude-agent-provider.mts`. Its resolved version and license are recorded in the generated legal notices.
- `@openai/codex` is the exact development pin used to generate the app-server protocol committed in `src/main/codex/protocol`; call sites are in `src/main/codex`. The shipped app runs the Codex executable installed by the user, not this npm package.
- `@trycua/cua-driver` is the exact npm pin that provides the embedded host. Its call site is `src/main/computer-use-host.ts`.
- The vendored Cua Driver binary, its archive checksum, source commits, transitive native versions, and corresponding-source pointers are pinned in `scripts/cua-driver-version.mjs`. `npm run prepare:cua` downloads the binary whenever `vendor/cua-driver/version` no longer matches the pin.
- `assets/legal/CUA-RUST-DEPENDENCIES.html` and `assets/legal/UBJS-NATIVE-DEPENDENCIES.html` record the native dependencies shipped with CUA for the `aarch64-apple-darwin` target.
- `assets/legal/NPM-RUNTIME-LICENSES.txt` and `assets/legal/THIRD-PARTY-NOTICES.txt` are generated from the lockfile and `scripts/legal/THIRD-PARTY-NOTICES.template.txt`.

The CUA npm packages, vendored binary, release metadata, and native reports are one dependency release. Move them together or the embedded host can talk to a binary it was not built against, and the distributed notices can describe the wrong code.

The Codex package and generated protocol are also one dependency in two places. Move them together or the committed types describe a different app server than the binary the app runs.

Never hand-edit the generated legal notices. Run `npm run prepare:cua`, review their diff, and commit every changed notice with the dependency that caused it. This applies even when the dependency does not currently appear in a notice. The generator is the source of truth and may cover more packages later.

`~/.local/bin/cua-driver`, the standalone CLI, is a separate install and out of scope. Leave it alone unless asked.

## 1. Check

```
grep -n "claude-agent-sdk\|openai/codex\|trycua" package.json
grep '"version"' node_modules/@anthropic-ai/claude-agent-sdk/package.json
grep '"version"' node_modules/@openai/codex/package.json
npm view @anthropic-ai/claude-agent-sdk version
npm view @openai/codex version
npm view @trycua/cua-driver version
node -e 'import("./scripts/cua-driver-version.mjs").then(({ CUA_DRIVER_VERSION, UBJS_VERSION }) => console.log({ CUA_DRIVER_VERSION, UBJS_VERSION }))'
grep -n "CODEX_PROTOCOL_VERSION" src/main/codex/protocol/version.ts
```

All current: say so, stop.

Ignore the `check_for_update` MCP tool here. It reports the standalone CLI's version from a 20h on-disk cache, not this repo's.

## 2. Analyse each new version for breaking changes

All three packages are pre-1.0, so a patch bump can still break. Never judge from the version number alone, and read before installing.

1. Read the release notes.
   - Cua Driver: `https://github.com/trycua/cua/releases/tag/cua-driver-rs-v<version>`
   - Agent SDK: releases on `anthropics/claude-agent-sdk-typescript`. Neither package ships a CHANGELOG.
   - Codex: the matching CLI release on `https://github.com/openai/codex/releases`.
2. Diff the candidate interface before installing so the tree stays untouched while you decide.
   - Agent SDK and Cua Driver: `npm pack <package>@<version>` into a temp dir, unpack, and diff its `.d.ts` files against the copy in `node_modules`.
   - Codex: pack the matching `@openai/codex@<version>-darwin-arm64` package into a temp dir, unpack it, run its `vendor/aarch64-apple-darwin/bin/codex app-server generate-ts --out <temp-output>`, and diff that output against `src/main/codex/protocol`. Ignore `version.ts`, which this repo adds after generation.
3. Read every hit against the repo's own call sites listed above.

Breaking means an export a production call site uses was removed, renamed, or changed incompatibly; a default changed in a way that changes behaviour; or a new required config or permission step. A generated response gaining a required nullable field is not breaking when production code only receives or ignores that field. Update typed test fixtures mechanically and continue. Do not change runtime behaviour solely to satisfy a fixture.

**If it breaks, stop.** Change nothing. Report the dependency, version, breakage, affected call sites, and required migration. The user decides whether to take it on.

**If it is clean, continue** one dependency at a time.

## 3. Apply

Agent SDK:

```
npm install @anthropic-ai/claude-agent-sdk@<version>
npm run prepare:cua
npm run check:licenses
```

Review `assets/legal/NPM-RUNTIME-LICENSES.txt` and `assets/legal/THIRD-PARTY-NOTICES.txt`. The resolved Agent SDK version must appear in both files. Do not copy the previous license entry forward without checking the installed package's current license or legal pointer.

Keep Codex pinned exactly and regenerate the entire protocol tree:

```
npm install --save-exact @openai/codex@<version>
npm run generate:codex-protocol
npm run prepare:cua
npm run check:licenses
```

Confirm `src/main/codex/protocol/version.ts` matches the installed version. Review the generated diff, including added and removed files; do not hand-edit generated protocol files.

Update the Cua Driver npm package and vendored binary in the same step:

```
npm install --save-exact @trycua/cua-driver@<version>
curl -fsSL -o /tmp/cua.tgz https://github.com/trycua/cua/releases/download/cua-driver-rs-v<version>/cua-driver-rs-<version>-darwin-arm64.tar.gz
shasum -a 256 /tmp/cua.tgz
```

Add the release to the `releases` map in `scripts/cua-driver-version.mjs`. Record all of the following from the exact release tag and its locked sources. Do not guess or carry a value forward because its package version looks unchanged.

- Full CUA source commit.
- Downloaded archive SHA-256.
- Resolved UBJS version and full source commit.
- UniFFI version and full source commit.
- `libffi` and `libffi-sys` versions.

Regenerate `assets/legal/CUA-RUST-DEPENDENCIES.html` from the new CUA source commit and `assets/legal/UBJS-NATIVE-DEPENDENCIES.html` from the new UBJS source commit. Scope both reports to production dependencies linked into the shipped native artifacts for `aarch64-apple-darwin`. Exclude development-only and build-only dependencies, as the notices state. Do not replace version strings in an old report. If the exact graph or license text cannot be reproduced, stop and report the missing source or tooling instead of committing the update.

```
npm run prepare:cua
npm run check:licenses
cat vendor/cua-driver/version
./vendor/cua-driver/cua-driver --version
```

`prepare:cua` checks the archive hash, regenerates the lockfile-based notices, and rejects stale pinned native reports. Review every changed file under `assets/legal` before continuing.

## 4. Verify

Run `npm run check:licenses` and then `npm test`. The first command gives notice drift a clear failure before the broader suite runs. If `tests/renderer.test.mts` needs isolation, re-run it with `npx vitest run tests/renderer.test.mts --testTimeout=30000` before calling it a failure.

Before committing, run `git diff --check` and inspect `git diff --name-only`. A dependency update is incomplete if `npm run prepare:cua` changed a legal file and that file is missing from the commit.

## 5. Commit

Make one commit per dependency. Stage only that dependency's files:

- Agent SDK: `package.json`, `package-lock.json`, `assets/legal/NPM-RUNTIME-LICENSES.txt`, and `assets/legal/THIRD-PARTY-NOTICES.txt`. Commit as `Move the agent SDK to <version>`.
- Codex: `package.json`, `package-lock.json`, and `src/main/codex/protocol`. Include `scripts/generate-codex-protocol.mts` if generation needed a fix, any behaviour-preserving typed fixture updates required by the generated responses, and either generated legal notice if it changed. Commit as `Move Codex to <version>`.
- Cua Driver: `package.json`, `package-lock.json`, `scripts/cua-driver-version.mjs`, `assets/legal/CUA-RUST-DEPENDENCIES.html`, `assets/legal/UBJS-NATIVE-DEPENDENCIES.html`, `assets/legal/NPM-RUNTIME-LICENSES.txt`, and `assets/legal/THIRD-PARTY-NOTICES.txt`. Commit as `Move the Cua Driver to <version>`.

When updating more than one, finish and commit each dependency before touching the next because they share `package.json`.

`vendor/cua-driver/` is gitignored. The working tree usually carries unrelated in-flight edits. Never stage them. Don't push unless asked.
