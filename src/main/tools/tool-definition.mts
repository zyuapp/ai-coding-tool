import type { z } from "zod";

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/**
 * One tool the app offers an agent, described apart from whatever host serves it. `readOnly` says
 * a call changes nothing the user can see, which is what lets a host grant it without asking.
 */
export type ToolDefinition<Bridge, Shape extends z.ZodRawShape = z.ZodRawShape> = {
  name: string;
  description: string;
  input: Shape;
  readOnly: boolean;
  run(bridge: Bridge, args: z.infer<z.ZodObject<Shape>>): Promise<ToolResult>;
};

/** A definition with its bridge supplied, which is all a host needs to serve it. */
export type BoundTool<Shape extends z.ZodRawShape = z.ZodRawShape> = {
  name: string;
  description: string;
  input: Shape;
  handler(args: z.infer<z.ZodObject<Shape>>): Promise<ToolResult>;
};

/** Pins the input shape so `run` sees typed arguments inside a heterogeneous list. */
export function defineTool<Bridge, Shape extends z.ZodRawShape>(definition: ToolDefinition<Bridge, Shape>): ToolDefinition<Bridge, Shape> {
  return definition;
}

export function bindTools<Bridge>(bridge: Bridge, definitions: readonly ToolDefinition<Bridge>[]): BoundTool[] {
  return definitions.map((definition) => ({
    name: definition.name,
    description: definition.description,
    input: definition.input,
    handler: (args) => definition.run(bridge, args),
  }));
}
