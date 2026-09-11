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

## Resolve setup blockers

Native report setup is automated by `npm run generate:native-licenses`. It installs pinned Rust and cargo-about tooling and caches source archives and reports under `/tmp/ai-coding-tool-native-licenses-<uid>`. It does not change shell configuration or standalone CLI installations. Reuse that cache; do not reconstruct report templates or license clarifications by hand. `NATIVE_LICENSE_CACHE` can select another temporary cache directory.

If the sandbox blocks downloads or localhost test listeners, retry through the environment's permission mechanism. If a package or executable is for another platform, obtain the matching host build of the same candidate version for executable checks. Neither an initial network error nor an absent local tool is enough to declare the update blocked.

Stop an affected update only for the compatibility problems defined below, or when required evidence still cannot be obtained after reasonable setup and recovery attempts. Report the specific remaining blocker and what was tried. Never weaken compatibility checks, invent source metadata, or commit incomplete native notices to get past a blocker; continue other dependencies that can be completed independently.

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

For Codex, protocol compatibility is not enough: `src/main/codex/codex-home.mts` shares selected configuration/auth inputs with symlinks while `app-server-client.mts` isolates sessions, SQLite, and logs; account/sign-in/usage operations keep the original home. Read these files and run the real-binary compatibility test against the unpacked candidate **before installing it**:

```sh
CODEX_COMPAT_BINARY=/absolute/path/to/candidate/codex npx vitest run tests/main/codex/codex-home-compatibility.test.mts
```

The test uses temporary homes, synthetic credentials, and a localhost Responses/OAuth server; it never needs a real login or paid model request. Do not replace it with mocked app-server assertions or skip it because the generated types match. It checks storage isolation despite inherited path overrides, shared instructions/skills, config writes, OAuth refresh across processes, auth-link repair, and durable resume/fork/title/goal/archive behavior. Treat a failure or an unverified candidate as an incomplete compatibility assessment, not a safe update.

Also inspect the candidate's config/auth/storage changes for new home-relative inputs, keychain identity changes, renamed storage flags, symlink replacement, and login/logout behavior; the fixture cannot detect every new input or platform-specific credential backend. Keep the shared-input allowlist explicit: never share the whole home, sessions, databases, logs, or other activity state to make a check pass. Do not switch credential backends, copy real tokens, silently fall back to shared history, or edit real Codex settings during validation. If compatibility requires runtime changes, report the breakage and proposed fix under the breaking-change rule below; once that migration is authorized, fix it and rerun the candidate probe and repository checks before committing.

Breaking means an export a production call site uses was removed, renamed, or changed incompatibly; a default changed in a way that changes behaviour; or a new required config or permission step. A generated response gaining a required nullable field is not breaking when production code only receives or ignores that field. Update typed test fixtures mechanically and continue. Do not change runtime behaviour solely to satisfy a fixture.

**If it breaks, stop that dependency's update.** Leave its pin and runtime unchanged. Report the dependency, version, breakage, affected call sites, and required migration. The user decides whether to take it on.

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
- Downloaded macOS archive SHA-256 and the release's Linux x64/arm64 archive checksums. Keep all platform checksums in the release metadata consumed by `scripts/prepare-cua-driver.mts`.
- Resolved UBJS version and full source commit.
- UniFFI version and full source commit.
- `libffi` and `libffi-sys` versions.

Generate or reuse the native reports with one command after recording the release pins:

```sh
npm run generate:native-licenses
```

The command verifies exact source/build inputs and report checksums. Unchanged reports need no downloads or Rust tools. A new CUA release reuses the UBJS report when its upstream source, native versions, and reviewed CUA build transformation are unchanged. Otherwise it automatically runs `cargo-about generate --locked --fail` for the production `aarch64-apple-darwin` graph, excluding build-only and development-only dependencies. Downloaded sources, tooling, and generated reports are cached. `-- --force` bypasses report reuse for a deliberate regeneration check; routine updates do not need it.

Review changed reports and `scripts/legal/native-reports.lock.json`, which records their source, recipe, lockfile, and output hashes. Commit that receipt with the dependency even when the HTML is unchanged. Never hand-edit a report or its receipt to pass validation.

Investigate only command failures or newly changed license entries. Reviewed report templates and checksum-verified license clarifications live in `scripts/legal/native/`. If a source license or CUA's UBJS build transformation changes, inspect the exact source before updating its recipe/checksum; do not exclude an unresolved crate or guess its license. A new license clarification must use the upstream license text, or complete text from its steward when the source only references it. Keep existing valid dual-license selections.

If required evidence remains unavailable, follow **Resolve setup blockers**, leave that dependency unchanged, and report the missing evidence. Continue independent dependency updates.

```
npm run prepare:cua
npm run check:licenses
cat vendor/cua-driver/version
./vendor/cua-driver/cua-driver --version
```

`prepare:cua` checks the archive hash, regenerates the lockfile-based notices, and rejects stale pinned native reports. Review every changed file under `assets/legal` before continuing.

## 4. Verify

Run `npm run check:licenses` and then `npm test`. The first command gives notice drift a clear failure before the broader suite runs. If `tests/renderer.test.mts` needs isolation, re-run it with `npx vitest run tests/renderer.test.mts --testTimeout=30000` before calling it a failure.

Update stale dependency-version fixtures to use the shared release pins while preserving explicit mismatched versions in rejection tests. These fixture changes are part of the dependency update, not runtime breakage. Rerun the affected checks before committing.

For Codex, `npm test` runs the same offline compatibility fixture against the newly installed development pin. Also run it with `CODEX_COMPAT_BINARY="$(command -v codex)"` when the user's installed CLI differs, since that is the executable the shipped app uses; report which versions were exercised. A missing binary or blocked localhost listener is a verification gap, not a passing check. Reuse the existing Codex-home and task-database tests for launcher/link and clean-cutover changes.

Before committing, run `git diff --check` and inspect `git diff --name-only`. A dependency update is incomplete if `npm run prepare:cua` changed a legal file and that file is missing from the commit.

## 5. Commit

Make one commit per dependency. Stage only that dependency's files:

- Agent SDK: `package.json`, `package-lock.json`, `assets/legal/NPM-RUNTIME-LICENSES.txt`, and `assets/legal/THIRD-PARTY-NOTICES.txt`. Commit as `Move the agent SDK to <version>`.
- Codex: `package.json`, `package-lock.json`, and `src/main/codex/protocol`. Include `scripts/generate-codex-protocol.mts` if generation needed a fix, any behaviour-preserving typed fixture updates required by the generated responses, and either generated legal notice if it changed. Commit as `Move Codex to <version>`.
- Cua Driver: `package.json`, `package-lock.json`, `scripts/cua-driver-version.mjs`, `scripts/legal/native-reports.lock.json`, `assets/legal/CUA-RUST-DEPENDENCIES.html`, `assets/legal/UBJS-NATIVE-DEPENDENCIES.html`, `assets/legal/NPM-RUNTIME-LICENSES.txt`, and `assets/legal/THIRD-PARTY-NOTICES.txt`. Include any required native report recipe or generator changes, `scripts/prepare-cua-driver.mts` fixes, and behaviour-preserving packaging fixture updates. Commit as `Move the Cua Driver to <version>`.

When updating more than one, finish and commit each dependency before touching the next because they share `package.json`.

`vendor/cua-driver/` is gitignored. The working tree usually carries unrelated in-flight edits. Never stage them. Don't push unless asked.
