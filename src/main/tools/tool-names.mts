/** How every engine names a tool an MCP server offers, and what the app's grants are written against. */
export function mcpToolName(server: string, name: string) {
  return `mcp__${server}__${name}`;
}

/** The names of a server's read-only tools, taken from the definitions so an allow list cannot drift from them. */
export function readOnlyToolNames(server: string, definitions: readonly { name: string; readOnly: boolean }[]) {
  return new Set(definitions.flatMap((definition) => definition.readOnly ? [mcpToolName(server, definition.name)] : []));
}
