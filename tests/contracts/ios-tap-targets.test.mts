import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";

const root = path.resolve(import.meta.dirname, "../../ios/AICodingTool");
const styleFile = "UI/TapTarget.swift";

const sources = readdirSync(root, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".swift"))
  .map((file) => ({ file, text: readFileSync(path.join(root, file), "utf8") }));

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** Index of the bracket closing the one at `open`. */
function closing(text: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const stack: string[] = [];
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]!;
    if (char in pairs) stack.push(pairs[char]!);
    else if (char === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) return index;
    }
  }
  throw new Error(`Unbalanced bracket at ${open}`);
}

function skipSpace(text: string, index: number): number {
  while (/\s/.test(text[index] ?? "")) index += 1;
  return index;
}

/** The modifiers chained onto the expression ending at `end`: the rest of its line, then every line starting with a dot. */
function chainAfter(text: string, end: number): string {
  const lines = text.slice(end).split("\n");
  const chain = [lines[0]!];
  for (const line of lines.slice(1)) {
    if (!line.trim().startsWith(".")) break;
    chain.push(line);
  }
  return chain.join("\n");
}

type Button = { file: string; line: number; label: string | undefined; chain: string };

function buttons(file: string, text: string): Button[] {
  const found: Button[] = [];
  for (const match of text.matchAll(/\bButton\b(?!Style)/g)) {
    let index = skipSpace(text, match.index + match[0].length);
    let args = "";
    if (text[index] === "(") {
      const end = closing(text, index);
      args = text.slice(index, end + 1);
      index = skipSpace(text, end + 1);
    }
    let trailing: string | undefined;
    let label: string | undefined;
    let end = index;
    if (text[index] === "{") {
      const close = closing(text, index);
      trailing = text.slice(index + 1, close);
      end = close + 1;
      const next = skipSpace(text, end);
      if (text.startsWith("label:", next)) {
        const open = skipSpace(text, next + "label:".length);
        const labelClose = closing(text, open);
        label = text.slice(open + 1, labelClose);
        end = labelClose + 1;
      }
    }
    if (label === undefined && /\baction:/.test(args)) label = trailing;
    if (args === "" && trailing === undefined) continue;
    found.push({ file, line: lineOf(text, match.index), label, chain: chainAfter(text, end) });
  }
  return found;
}

test("plain button styles come only from the target style, which hit-tests the whole label", () => {
  const offenders = sources.flatMap(({ file, text }) =>
    file === styleFile
      ? []
      : [...text.matchAll(/\.buttonStyle\(\s*\.(?:plain|borderless)\s*\)|\b(?:Plain|Borderless)ButtonStyle\(\)/g)].map((match) => `${file}:${lineOf(text, match.index)}`),
  );
  assert.deepEqual(offenders, [], "Use .buttonStyle(.target) so taps on a label's clear or glass area count");
});

test("custom button styles hit-test the whole label", () => {
  const offenders = sources.flatMap(({ file, text }) =>
    [...text.matchAll(/:\s*(?:Primitive)?ButtonStyle\s*\{/g)]
      .filter((match) => !text.slice(match.index, closing(text, text.indexOf("{", match.index))).includes("contentShape"))
      .map((match) => `${file}:${lineOf(text, match.index)}`),
  );
  assert.deepEqual(offenders, [], "Give the label a contentShape in makeBody");
});

test("tap gestures sit on a view with a content shape", () => {
  const offenders = sources.flatMap(({ file, text }) => {
    const lines = text.split("\n");
    return lines.flatMap((line, index) => {
      if (!line.includes(".onTapGesture")) return [];
      let start = index;
      while (start > 0 && lines[start]!.trim().startsWith(".")) start -= 1;
      return lines.slice(start, index + 1).join("\n").includes(".contentShape(") ? [] : [`${file}:${index + 1}`];
    });
  });
  assert.deepEqual(offenders, [], "Add .contentShape(...) before .onTapGesture so taps on clear areas count");
});

test("icon-only target buttons are at least 44 points each way", () => {
  const offenders = sources
    .flatMap(({ file, text }) => buttons(file, text))
    .filter(({ label, chain }) => chain.includes(".buttonStyle(.target)") && label !== undefined && /^\s*(?:SwiftUI\.)?Image\(systemName:/.test(label))
    .filter(({ label }) => !label!.includes(".minimumTapTarget()"))
    .filter(({ label }) =>
      ![...label!.matchAll(/\.frame\(([^)]*)\)/g)].some(([, frame]) => {
        const width = /(?:^|\s|,)(?:minWidth|width):\s*(\d+)/.exec(frame!)?.[1];
        const height = /(?:^|\s|,)(?:minHeight|height):\s*(\d+)/.exec(frame!)?.[1];
        return Number(width) >= 44 && Number(height) >= 44;
      }),
    )
    .map(({ file, line }) => `${file}:${line}`);
  assert.deepEqual(offenders, [], "Frame the icon's label at 44×44, or add .minimumTapTarget()");
});
