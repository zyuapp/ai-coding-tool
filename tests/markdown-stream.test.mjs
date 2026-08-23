import assert from "node:assert/strict";
import test from "node:test";
import { emptyScan, inlineSafeEnd, repairCut, scanBlocks } from "../dist/main/domain/markdown-stream.js";

test("a cut inside inline markup moves back to before the markup", () => {
  assert.equal(repairCut("Then a **partly"), "Then a ");
  assert.equal(repairCut("Use `npm ru"), "Use ");
  assert.equal(repairCut("See [the docs](http"), "See ");
  assert.equal(repairCut("Some ~~struck"), "Some ");
  assert.equal(repairCut("An <http"), "An ");
});

test("markup the stream has already closed is kept", () => {
  assert.equal(repairCut("Then a **partly**"), "Then a **partly**");
  assert.equal(repairCut("a `code` span"), "a `code` span");
  assert.equal(repairCut("one *two* three"), "one *two* three");
  assert.equal(repairCut("[the docs](https://x) and on"), "[the docs](https://x) and on");
});

test("a lone underscore or asterisk in prose is not treated as an opener", () => {
  assert.equal(repairCut("The task_id field is fine"), "The task_id field is fine");
  assert.equal(repairCut("2 * 3 is six"), "2 * 3 is six");
});

test("emphasis left open across lines holds back the rest of the block", () => {
  assert.equal(repairCut("Multi **line\nemphasis still open"), "Multi ");
});

test("an open fence is closed so its content renders as code", () => {
  assert.equal(repairCut("```ts\nconst a = 1;\nconst b"), "```ts\nconst a = 1;\nconst b\n```\n");
  assert.equal(repairCut("```ts"), "", "a fence with nothing in it yet waits");
});

test("a table is held back until its delimiter row lands", () => {
  assert.equal(repairCut("| a | b |\n| c | d |"), "");
  assert.equal(repairCut("| a | b |\n| --- | --- |\n| c | d"), "| a | b |\n| --- | --- |\n| c | d");
  assert.equal(repairCut("Intro line\n| a | b |"), "Intro line\n", "the prose above the table still reads");
});

test("a line that is still only markers waits for its content", () => {
  assert.equal(repairCut("## "), "");
  assert.equal(repairCut("## Head"), "## Head");
  assert.equal(repairCut("- "), "");
});

test("text with nothing half-written is passed through whole", () => {
  assert.equal(inlineSafeEnd("Plain sentence."), "Plain sentence.".length);
  assert.equal(repairCut("Plain sentence."), "Plain sentence.");
  assert.equal(repairCut(""), "");
});

test("inline scanning skips long plain spans without missing later markers", () => {
  const plain = "ordinary prose ".repeat(1_000);
  const beforeOpen = `${plain}! still plain `;
  assert.equal(inlineSafeEnd(`${beforeOpen}**open`), beforeOpen.length);
  assert.equal(inlineSafeEnd(`${plain}\\* escaped`), `${plain}\\* escaped`.length);
  assert.equal(inlineSafeEnd(`${plain}\`closed\` tail`), `${plain}\`closed\` tail`.length);
});

test("the block scan still cuts only at whole blocks, which is what a run commits", () => {
  assert.equal(scanBlocks("One block.\n\nStill writing", emptyScan()).safeEnd, "One block.\n\n".length);
  assert.equal(scanBlocks("```ts\ncode\n", emptyScan()).safeEnd, 0, "an open fence never commits");
});
