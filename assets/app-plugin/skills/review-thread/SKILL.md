---
name: review-thread
description: Start a companion thread that reviews this thread's work, fix the real findings, and loop until the reviewer approves. Arguments name the reviewer's engine or model, its effort, and any review focus.
argument-hint: "[claude|codex|<model>] [<effort>] [focus]"
---

# Review thread

Run a review loop with a separate AICodingTool thread. The reviewer reads and judges; this thread fixes. Use the app's thread tools (`start_thread`, `wait_for_thread`, `message_thread`, `read_thread`). They are AICodingTool threads, not native subagents, sessions, or background tasks.

## Arguments

The words after `/review-thread`, in any order:

- An engine (`claude`, `codex`) or a model id (`fable`, `opus`, `sonnet`, `haiku`, `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`). An engine alone means that engine's default model. Omitted: the reviewer inherits this thread's model.
- An effort (`low`, `medium`, `high`, `xhigh`, `max`, `ultra`). Omitted: the reviewer inherits this thread's effort.
- Everything else is review focus, passed to the reviewer verbatim.

## 1. Define the work

Before starting the reviewer, settle:

- The base: the commit this thread's work builds on. If this thread made no commits, the base is `HEAD`. If it made commits, the base is the parent of its first commit. Record the SHA with `git rev-parse`.
- The scope: what was asked, in one or two sentences, and what was deliberately left out.
- The files this thread touched.

Do not edit anything while a review round is running. The reviewer reads the working tree.

## 2. Start the reviewer

Call `start_thread` once. Pass `model` and `effort` only when arguments named them. Do not pass `worktree` or `worktreeId`; the new thread starts in this thread's checkout. The prompt must stand alone. Use this template:

```
You are the reviewer for another AICodingTool thread's work. Review only; never edit, commit, stash, or run formatters. Read the repository's AGENTS.md or CLAUDE.md first.

Work under review
- Base commit: <sha>
- Diff: `git diff <sha>` plus untracked files, in this checkout
- Request: <scope>
- Out of scope by design: <exclusions>
- Files touched: <list>
- Focus: <focus or "none">

Review vectors, in order of weight
1. Correctness: the change does what was requested, is secure, and works for every engine the app supports.
2. Architecture: the change follows the rules in AGENTS.md.
3. Performance: no avoidable cost on hot paths or large inputs.
4. Quality: tests cover new and changed behaviour, comments follow the repository's comment rules.
5. Scope control: nothing requested is missing, nothing beyond the request was added, no unrelated files are in the diff.

Verdict rule: any finding under 1, 2, or 5 means changes requested. Findings under 3 or 4 mean changes requested only at high severity; otherwise list them as optional.

Reply in exactly this shape, and nothing before the first line:

VERDICT: approved | changes-requested
FINDINGS:
- [blocking|optional] <vector> <file>:<line> — <one-sentence claim> — <how it fails>
(or "none")
VERIFIED:
- <finding from the previous round> — fixed | not fixed: <why>
(only after the first round)

Later rounds arrive as messages in this thread. In a later round, verify each finding you were told was fixed, then review only the delta since the SHA in that message. Raise a new finding on unchanged code only when it is blocking.
```

Reply to the user with one line linking the reviewer as `[Review: <title>](aicodingtool://thread/<id>)`, then wait.

## 3. Wait and judge

Call `wait_for_thread` with `timeoutSeconds` 900. While it answers "Still working", call it again; do not poll `read_thread`.

When the verdict arrives:

- `approved`: go to step 5.
- `changes-requested`: for each finding, decide whether it is real and inside the request's scope. Fix the ones that are. Reject the rest with a one-line reason each. Do not widen the work to satisfy an optional finding.

Tell the user, in one short message, which findings you are fixing and which you rejected and why.

## 4. Fix and send the next round

Make the fixes and run the checks this repository expects. Record the current `HEAD` or, for uncommitted work, note that the delta is in the working tree since your last message. Then call `message_thread` on the reviewer:

```
Round <n>.
Fixed: <finding> — <what changed>
Rejected: <finding> — <why>
Delta to review: `git diff <previous sha>` and the working tree.
Verify the fixes, review the delta, and reply in the same shape.
```

Return to step 3. Stop after three rounds even without approval.

## 5. Finish

Report to the user in one message: the final verdict, how many rounds ran, what was fixed, and any finding left open with its reason. Then continue the thread's normal finishing steps for the original request, including the commit if the request called for one. Leave the reviewer thread open; the user may want to ask it questions.
