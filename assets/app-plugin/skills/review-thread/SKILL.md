---
name: review-thread
description: Start a companion thread that reviews this thread's work, fix the real findings, and loop until the reviewer approves. Arguments name the reviewer's engine or model, its effort, and any review focus. Use when the user asks for a review thread, often with a model or effort, such as "review thread with sol xhigh".
argument-hint: "[<engine>|<model>] [<effort>] [focus]"
---

# Review thread

Run a review loop with a separate AICodingTool thread. The reviewer reads and judges; this thread fixes. Use the app's thread tools (`start_thread`, `wait_for_thread`, `message_thread`, `read_thread`). They are AICodingTool threads, not native subagents, sessions, or background tasks.

## Arguments

The words after `/review-thread`, in any order:

- An engine or a model: any that `start_thread`'s `model` field names, or any model in the app's model picker, by its id or by the name the picker shows. Pass the user's word as `model` unchanged first: a name several providers offer resolves to the one the user pinned, and is refused with its candidates otherwise, which you then put to the user. Pass an engine alone as the `model` of `start_thread`; it means that engine's default model. Omitted: the reviewer inherits this thread's model.
- Users name models loosely: "synthetic deepsek 4.1" means `synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017`. If `start_thread` says no engine offers it, search `start_thread`'s `model` list and `opencode models | grep -i <one word of the name>` for models matching every part of the user's word, ignoring case, punctuation and typos. One match: use its full id and name it in your reply. Otherwise ask, listing the closest.
- An effort, one of those `start_thread`'s `effort` field takes. Omitted: the reviewer inherits this thread's effort.
- Everything else is review focus, passed to the reviewer verbatim.

## 1. Define the work

Before starting the reviewer, settle:

- The base: the commit this thread's work builds on. If this thread made no commits, the base is `HEAD`. If it made commits, the base is the parent of its first commit. Record the SHA with `git rev-parse`.
- The intent: every message from the user that shapes this work, copied verbatim, oldest first, including later corrections. Keep attachment paths.
- The exclusions: what was deliberately left out, and why.
- The evidence: each check you ran with its result, and how you exercised the changed behaviour.
- The files this thread touched.

Do not edit anything while a review round is running. The reviewer reads the working tree.

## 2. Start the reviewer

Call `start_thread` once with `role: "reviewer"`, so the review stays in Threads unless it needs the user's approval. A reviewer starts on Auto, or on Bypass where its engine has no Auto, so its round never waits on an approval. Pass `model` and `effort` only when arguments named them. Do not pass `worktree` or `worktreeId`; the new thread starts in this thread's checkout. The prompt must stand alone. Use this template:

```
You are the reviewer for another AICodingTool thread's work. Review only; never edit, commit, stash, or run formatters. Read the repository's AGENTS.md or CLAUDE.md first.

Work under review
- Base commit: <sha>
- Diff: `git diff <sha>` plus untracked files, in this checkout
- User's words, verbatim, oldest first. These define the request and outrank the exclusions below:
  <messages>
- Out of scope by design: <exclusions>. Do not ask for these to be built; still read them and check how the change interacts with them.
- Files touched: <list>
- Focus: <focus or "none">
- Implementer's evidence: <evidence>
The exclusions and evidence are the implementer's claims. Check each against the repository before you rely on it.

Review vectors, in order of weight
1. Correctness: the change does what was requested and works for every engine the app supports. Open the code that produces each value the change reads and the code that consumes each value it writes, inside the diff or not, and check that it still works. When the change sends new inputs into unchanged code, check what those inputs newly reach there: size limits, caps, totals across many items. Check state saved before the change, each mode the code runs in, and each setting's default. Check what happens when a step fails halfway, or when two requests run at once: for each call the change makes to something that can reject or fail (an API, a database, a queue), say what the user ends up seeing when it does.
   Trust: for each permission, role, or resource the change grants, name who controls each fact it combines, and check whether valid facts can be arranged into a combination nobody authorized. Check whether inputs an outsider controls can cause cost: paid calls, jobs, storage.
2. Architecture: the change follows the rules in AGENTS.md.
3. Performance: no avoidable cost on hot paths or large inputs.
4. Quality: tests cover new and changed behaviour, comments follow the repository's comment rules.
5. Scope control: nothing requested is missing, nothing beyond the request was added, no unrelated files are in the diff.
6. Evidence: the implementer's evidence exercises each behaviour change. Raise a finding only when no reported check did.
7. Simplicity: every added abstraction, branch, option, or file is a cost. Name any that a simpler change could remove while still meeting the request.

Edges: for each comparison, version or range check, threshold, limit, regex, parser, validation, time window, timeout, or retry the change adds or alters, list the inputs at its boundaries and check each against base and head: equal to the limit, just past it, empty, zero, negative, the largest value, an unexpected format, a value with extra parts (prefixes, suffixes, metadata, separators), text that only looks like a match, a reversed or descending range. An edge finding names the caller, saved state, user action, or external data that produces its input. To settle an unclear boundary, you may write a small probe script under /tmp that copies or imports one function. Never run the change's tests or build, and never install anything.

Do not stop at the first finding. List every one that qualifies, then check each against the code once more and drop any you cannot confirm. "The base has the same problem" excuses a finding only when the same inputs reached that code on the base. Each finding names the input or state that triggers it and the wrong result.

Blocking bar: report a finding only when all of these hold. Drop the rest.
- The change introduced it, sends new inputs to it, or leaves part of the request undone.
- Its trigger is reachable: you can name the caller, saved state, user action, or external data that produces it. An input you can only imagine does not count.
- The author would fix it if told. Its fix needs no more rigor than the surrounding code shows.
When no finding meets the bar, approve.

User decisions: when the user's words do not settle a finding, or fixing it would change or widen the scope, tag it `[decision]` and start its claim with `User decision:`, naming the decision. It never affects the verdict.

Verdict rule: any blocking finding means changes requested. Findings under 3, 4, 6, or 7 are blocking only at high severity; drop the rest.

Reply in exactly this shape, and nothing before the first line:

VERDICT: approved | changes-requested
FINDINGS:
- [blocking|decision] <vector> <file>:<line> — <one-sentence claim> — <triggering input or state> gives <wrong result>
(or "none")
VERIFIED:
- <finding from the previous round> — fixed | not fixed: <why>
(only after the first round)

Later rounds arrive as messages in this thread. In a later round, verify each finding you were told was fixed, then review the delta since the SHA in that message for what it broke: trace its producers and consumers, and run the edge checks only on boundaries the delta adds or changes. A finding the fix left open goes under VERIFIED as not fixed, where it still counts toward the verdict; do not repeat or reword it under FINDINGS. Raise new findings on code the delta did not change only when they are blocking.
```

Reply to the user with one line linking the reviewer as `[Review: <title>](aicodingtool://thread/<id>)`, then wait.

## 3. Wait and judge

Call `wait_for_thread` with `timeoutSeconds` 900. While it answers "Still working", call it again; do not poll `read_thread`. If the wait is interrupted or errors, call it again: the loop ends only on an approval or the user's word.

When the verdict arrives:

- `approved` after three or more rounds, with no fresh review yet: start one fresh reviewer as in step 2, with the same base and the current files touched, evidence and exclusions, and no round history. Link it to the user the same way and treat its verdict like any round's, sending later rounds to it. Start only one fresh reviewer per review.
- `approved` otherwise: go to step 5.
- `changes-requested`: for each finding, decide whether it is real and inside the request's scope. Fix the ones that are. Reject the rest with a one-line reason each. Leave each `User decision:` finding open for step 5.

Tell the user, in one short message, which findings you are fixing and which you rejected and why.

## 4. Fix and send the next round

Make the fixes and run the checks this repository expects. Record the current `HEAD` or, for uncommitted work, note that the delta is in the working tree since your last message. Then call `message_thread` on the reviewer:

```
Round <n>.
New user messages since last round, verbatim: <messages or "none">
Fixed: <finding> — <what changed>
Rejected: <finding> — <why>
Evidence: <checks run on the fixes, with results>
Delta to review: `git diff <previous sha>` and the working tree.
Verify the fixes, review the delta and the code it reaches, and reply in the same shape.
```

Return to step 3. Keep going until the reviewer answers `approved`. Never end your turn with a `changes-requested` verdict on the table: fixing it and sending the next round is your work, not the user's to prompt. Stop early, say so in step 5, and let the user decide when:
- the user says to;
- a reviewer has run five rounds without approving;
- every remaining finding is one you reject, or one you already fixed once, and the reviewer has kept it for two rounds running.

## 5. Finish

Report to the user in one message: the final verdict, how many rounds ran, what was fixed, and any finding left open with its reason, including each `User decision:` finding. Then continue the thread's normal finishing steps for the original request, including the commit if the request called for one. Leave the reviewer thread open; the user may want to ask it questions.
