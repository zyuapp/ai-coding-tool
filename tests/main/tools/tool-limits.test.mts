import assert from "node:assert/strict";
import { test } from "vitest";
import { z } from "zod";
import { isThreadRequest } from "../../../src/contracts/thread-requests.ts";
import { MAX_PROMPT_LENGTH } from "../../../src/contracts/ipc.ts";
import type { ThreadRequest } from "../../../src/contracts/threads.ts";
import { ThreadChannel } from "../../../src/main/agent/thread-channel.mts";
import { findingTools } from "../../../src/main/tools/automation.mts";
import { browserTools } from "../../../src/main/tools/browser.mts";
import { coordinationTools } from "../../../src/main/tools/coordination.mts";
import { terminalTools } from "../../../src/main/tools/terminal.mts";
import { threadTools } from "../../../src/main/tools/threads.mts";
import type { BoundTool } from "../../../src/main/tools/tool-definition.mts";

/** Longer than any limit the window reads a field under, for a field whose schema names none. */
const UNBOUNDED = MAX_PROMPT_LENGTH + 1;
const strings = new Map<number, string>();
const repeated = (length: number) => strings.get(length) ?? strings.set(length, "x".repeat(length)).get(length)!;

function inner(schema: z.ZodType): z.ZodType {
  return schema instanceof z.ZodOptional || schema instanceof z.ZodNullable ? inner(schema.unwrap() as z.ZodType) : schema;
}

/** A value the schema takes, for every field it has, optional ones included, so each field is tried beside all the others. */
function sample(schema: z.ZodType): unknown {
  const field = inner(schema);
  if (field instanceof z.ZodString) return repeated(Math.max(1, field.minLength ?? 1));
  if (field instanceof z.ZodNumber) return 1;
  if (field instanceof z.ZodBoolean) return true;
  if (field instanceof z.ZodEnum) return field.options[0];
  if (field instanceof z.ZodArray) return [sample(field.element as z.ZodType)];
  if (field instanceof z.ZodObject) return Object.fromEntries(Object.entries(field.shape).map(([key, value]) => [key, sample(value as z.ZodType)]));
  throw new Error(`No sample for ${field.constructor.name}`);
}

/** What lies at and just past each edge of a field: blank, at its limit, and over it. */
function edges(schema: z.ZodType): unknown[] {
  const field = inner(schema);
  const nullable = schema instanceof z.ZodNullable || schema instanceof z.ZodOptional && schema.unwrap() instanceof z.ZodNullable ? [null] : [];
  if (field instanceof z.ZodString) {
    const max = field.maxLength ?? UNBOUNDED;
    return [...nullable, "", " ", repeated(max), repeated(max + 1)];
  }
  if (field instanceof z.ZodNumber) return [...nullable, -1, 0, 0.5, 1e12];
  if (field instanceof z.ZodBoolean) return [...nullable, false, true];
  if (field instanceof z.ZodEnum) return [...nullable, ...field.options];
  return nullable;
}

type Case = { path: string; edge: unknown; args: Record<string, unknown> };

/** Every argument set that moves one field to one of its edges, nested fields of a list's first item included. */
function cases(shape: z.ZodRawShape): Case[] {
  const base = sample(z.object(shape)) as Record<string, unknown>;
  return Object.entries(shape).flatMap(([key, value]) => {
    const field = inner(value as z.ZodType);
    if (field instanceof z.ZodArray && inner(field.element as z.ZodType) instanceof z.ZodObject) {
      const item = inner(field.element as z.ZodType) as z.ZodObject;
      const first = (base[key] as Record<string, unknown>[])[0]!;
      return Object.entries(item.shape).flatMap(([nested, schema]) => edges(schema as z.ZodType)
        .map((edge) => ({ path: `${key}[0].${nested}`, edge, args: { ...base, [key]: [{ ...first, [nested]: edge }] } })));
    }
    return edges(value as z.ZodType).map((edge) => ({ path: key, edge, args: { ...base, [key]: edge } }));
  });
}

function described(value: unknown) {
  return typeof value === "string" && value.length > 20 ? `${value.length} characters` : JSON.stringify(value);
}

test("whatever a tool's schema takes, the window reads, so an agent is only ever refused on the field it got wrong", async () => {
  const posted: ThreadRequest[] = [];
  const channel: ThreadChannel = new ThreadChannel((request) => {
    posted.push(request);
    queueMicrotask(() => channel.settle({ type: "thread.response", requestId: request.requestId, ok: false, message: "answered" }));
  });
  const tools: BoundTool[] = [
    ...threadTools(channel.bridgeFor("task-1")),
    ...threadTools(channel.bridgeFor("task-1"), Date.now, "coordinator"),
    ...threadTools(channel.bridgeFor("task-1"), Date.now, "member"),
    ...coordinationTools(channel.coordinationFor("task-1"), "coordinator"),
    ...coordinationTools(channel.coordinationFor("task-1"), "member"),
    ...findingTools(channel.findingsFor("task-1")),
    ...browserTools(channel.browserFor("task-1")),
    ...terminalTools(channel.terminalFor("task-1")),
  ];
  const unread: string[] = [];
  let sent = 0;
  for (const tool of tools) {
    for (const { path, edge, args } of cases(tool.input)) {
      const parsed = z.object(tool.input).safeParse(args);
      if (!parsed.success) continue;
      posted.length = 0;
      await tool.handler(parsed.data);
      sent += posted.length;
      if (posted.some((request) => !isThreadRequest(request))) unread.push(`${tool.name} ${path} = ${described(edge)}`);
    }
  }
  assert.ok(sent > 100, "the tools were driven");
  assert.deepEqual(unread, []);
});
