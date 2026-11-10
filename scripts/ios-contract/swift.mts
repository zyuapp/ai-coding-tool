import { camelCased, type Command, type Contract, type Field, identifier, type Named, type Struct, type Swift, type Union } from "./model.mts";

/** How each generated type is used, which decides what Swift it gets. */
export type Uses = {
  /** Decoded from what the computer sends. */
  read: Set<string>;
  /** Built into what the phone sends, so it carries `json`. */
  sent: Set<string>;
  /** Held in a `Codable` struct, so a union encodes too. */
  stored: Set<string>;
  conformances: Record<string, string[]>;
};

export function typeName(swift: Swift): string {
  switch (swift.kind) {
    case "string": return "String";
    case "bool": case "flag": return "Bool";
    case "double": return "Double";
    case "int": return "Int";
    case "json": return "JSONValue";
    case "named": return swift.name;
    case "array": return `[${typeName(swift.element)}]`;
    case "map": return `[String: ${typeName(swift.value)}]`;
    case "result": return "Result<JSONValue, MobileServerMessage.AnswerError>";
  }
}

let known = new Map<string, Named>();

const fieldType = (field: Field): string => `${typeName(field.swift)}${field.optional || field.nullable ? "?" : ""}`;
const docLines = (doc: string[], indent: string): string[] => doc.map((line) => `${indent}/// ${line}`);

/** `value` as JSON, for what the phone sends. */
export function jsonOf(value: string, swift: Swift): string {
  if (swift.kind === "named" && known.get(swift.name)?.kind === "enum") return `JSONValue.string(${value}.rawValue)`;
  switch (swift.kind) {
    case "string": return `JSONValue.string(${value})`;
    case "bool": return `JSONValue.bool(${value})`;
    case "double": return `JSONValue.number(${value})`;
    case "int": return `JSONValue.number(Double(${value}))`;
    case "json": return value;
    case "named": return `${value}.json`;
    case "array": return `JSONValue.array(${value}.map { ${jsonOf("$0", swift.element)} })`;
    case "map": return `JSONValue.object(${value}.mapValues { ${jsonOf("$0", swift.value)} })`;
    case "flag": case "result": throw new Error(`${swift.kind} is not sent whole.`);
  }
}

/** A field as an entry of a `[String: JSONValue?]`, nil when it is left out. */
function sentEntry(field: Field, value: string): string {
  const key = JSON.stringify(field.name);
  if (field.swift.kind === "flag") return `${key}: ${value} ? .bool(true) : nil`;
  if (field.optional) return `${key}: ${value}.map { ${jsonOf("$0", field.swift)} }`;
  if (field.nullable) return `${key}: ${value}.map { ${jsonOf("$0", field.swift)} } ?? .null`;
  return `${key}: ${jsonOf(value, field.swift)}`;
}

function parameter(field: Field): string {
  if (field.swift.kind === "flag") return `${field.name}: Bool = false`;
  return `${field.name}: ${fieldType(field)}${field.optional ? " = nil" : ""}`;
}

function conformances(name: string, base: string[], uses: Uses): string {
  const extra = uses.conformances[name] ?? [];
  return [...base, ...extra, "Sendable"].join(", ");
}

function renderStruct(struct: Struct, indent: string, uses: Uses): string[] {
  const inner = `${indent}    `;
  const swiftName = struct.name.split(".").at(-1)!;
  if (struct.patch) return renderPatch(struct, indent, uses);
  return [
    ...docLines(struct.doc, indent),
    `${indent}struct ${swiftName}: ${conformances(struct.name, ["Codable", "Equatable"], uses)} {`,
    ...struct.nested.flatMap((nested) => [...renderStruct(nested, inner, uses), ""]),
    ...struct.fields.flatMap((field) => [
      ...docLines(field.doc, inner),
      `${inner}var ${identifier(field.name)}: ${fieldType(field)}${field.fallback === undefined ? "" : ` = ${field.fallback}`}`,
    ]),
    `${indent}}`,
  ];
}

function patchType(field: Field): string {
  if (field.patch === "field") return `PatchField<${typeName(field.swift)}?> = .absent`;
  if (field.patch === "value") return `PatchField<${typeName(field.swift)}> = .absent`;
  return fieldType(field);
}

function patchRead(field: Field): string {
  const key = `forKey: .${identifier(field.name)}`;
  if (field.patch === "field") return `try container.patchField(${typeName(field.swift)}.self, ${key})`;
  if (field.patch === "value") return `try container.patchValue(${typeName(field.swift)}.self, ${key})`;
  return `try container.decodeIfPresent(${typeName(field.swift)}.self, ${key})`;
}

/** A patch decodes absent and null apart where they differ, and applies what it names to its target. */
function renderPatch(struct: Struct, indent: string, uses: Uses): string[] {
  const inner = `${indent}    `;
  const body = `${inner}    `;
  return [
    ...docLines(struct.doc, indent),
    `${indent}struct ${struct.name}: ${conformances(struct.name, ["Decodable", "Equatable"], uses)} {`,
    ...struct.nested.flatMap((nested) => [...renderStruct(nested, inner, uses), ""]),
    ...struct.fields.flatMap((field) => [...docLines(field.doc, inner), `${inner}var ${identifier(field.name)}: ${patchType(field)}`]),
    "",
    `${inner}private enum CodingKeys: String, CodingKey {`,
    `${body}case ${struct.fields.map((field) => identifier(field.name)).join(", ")}`,
    `${inner}}`,
    "",
    `${inner}init() {}`,
    "",
    `${inner}init(from decoder: Decoder) throws {`,
    `${body}let container = try decoder.container(keyedBy: CodingKeys.self)`,
    ...struct.fields.map((field) => `${body}${identifier(field.name)} = ${patchRead(field)}`),
    `${inner}}`,
    `${indent}}`,
    "",
    ...renderApplying(struct, indent),
  ];
}

function renderApplying(struct: Struct, indent: string): string[] {
  const { target, handApplied } = struct.patch!;
  const inner = `${indent}    `;
  const body = `${inner}    `;
  const argument = camelCased(struct.name.replace(/^Mobile(Thread)?/, "")).toLowerCase();
  const lines = struct.fields.filter((field) => !handApplied.has(field.name)).map((field) => {
    const name = identifier(field.name);
    return field.patch ? `${body}next.${name} = ${argument}.${name}.applied(to: ${name})` : `${body}if let ${name} = ${argument}.${name} { next.${name} = ${name} }`;
  });
  const aside = [...handApplied].map((name) => `\`${name}\``).join(", ");
  return [
    `${indent}extension ${target} {`,
    `${inner}/// What \`${argument}\` names applied, all but ${aside}.`,
    `${inner}func applyingFields(_ ${argument}: ${struct.name}) -> ${target} {`,
    `${body}var next = self`,
    ...lines,
    `${body}return next`,
    `${inner}}`,
    `${indent}}`,
  ];
}

function caseSignature(fields: Field[]): string {
  const type = (field: Field) => field.swift.kind === "flag" ? "Bool = false" : field.fallback === undefined ? fieldType(field) : typeName(field.swift);
  return fields.length === 0 ? "" : `(${fields.map((field) => `${field.name}: ${type(field)}`).join(", ")})`;
}

function casePattern(fields: Field[]): string {
  return fields.length === 0 ? "" : `(${fields.map((field) => `let ${identifier(field.name)}`).join(", ")})`;
}

function caseFields(union: Union, fields: Field[]): Field[] {
  return union.frame ? [union.frame.envelope, ...fields] : fields;
}

function renderUnion(union: Union, uses: Uses): string[] {
  const read = uses.read.has(union.name) && !union.frame;
  const stored = uses.stored.has(union.name);
  const base = [...(read || stored ? [stored ? "Codable" : "Decodable"] : []), "Equatable"];
  const lines = [
    ...docLines(union.doc, ""),
    `enum ${union.name}: ${conformances(union.name, base, uses)} {`,
    ...union.cases.map((entry) => `    case ${identifier(entry.name)}${caseSignature(caseFields(union, entry.fields))}`),
  ];
  const keys = [...new Set([union.key, ...union.cases.flatMap((entry) => entry.fields.map((field) => field.name))])];
  if (read || stored) lines.push("", `    private enum CodingKeys: String, CodingKey { case ${keys.map(identifier).join(", ")} }`);
  if (read || stored) lines.push("", ...renderUnionDecode(union));
  if (stored) lines.push("", ...renderUnionEncode(union));
  if (uses.sent.has(union.name)) lines.push("", ...renderUnionJSON(union));
  if (union.frame) lines.push("", ...renderEnvelope(union));
  lines.push("}");
  if (union.frame) lines.push("", ...renderFrameRead(union));
  return lines;
}

function decodeField(field: Field): string {
  const key = `forKey: .${identifier(field.name)}`;
  const type = typeName(field.swift);
  if (field.fallback !== undefined) return `try container.decodeIfPresent(${type}.self, ${key}) ?? ${field.fallback}`;
  if (field.optional || field.nullable) return `try container.decodeIfPresent(${type}.self, ${key})`;
  return `try container.decode(${type}.self, ${key})`;
}

function decodedCase(union: Union, value: string): string {
  const entry = union.cases.find((candidate) => candidate.value === value)!;
  const values = entry.fields.map((field) => `${field.name}: ${decodeField(field)}`).join(", ");
  return `self = .${identifier(entry.name)}${entry.fields.length === 0 ? "" : `(${values})`}`;
}

function renderUnionDecode(union: Union): string[] {
  const key = `.${identifier(union.key)}`;
  const known = union.cases.filter((entry) => entry.value !== union.fallback).map((entry) => `        case ${JSON.stringify(entry.value)}: ${decodedCase(union, entry.value)}`);
  const fallback = union.fallback === undefined
    ? `        default: throw DecodingError.dataCorruptedError(forKey: ${key}, in: container, debugDescription: "Unknown ${union.key}")`
    : `        default: ${decodedCase(union, union.fallback)}`;
  return [
    "    init(from decoder: Decoder) throws {",
    "        let container = try decoder.container(keyedBy: CodingKeys.self)",
    `        switch try container.decode(String.self, forKey: ${key}) {`,
    ...known,
    fallback,
    "        }",
    "    }",
  ];
}

function encodeField(field: Field): string {
  const name = identifier(field.name);
  const key = `forKey: .${name}`;
  if (field.optional) return `try container.encodeIfPresent(${name}, ${key})`;
  if (field.nullable) return `if let ${name} { try container.encode(${name}, ${key}) } else { try container.encodeNil(${key}) }`;
  return `try container.encode(${name}, ${key})`;
}

function renderUnionEncode(union: Union): string[] {
  return [
    "    func encode(to encoder: Encoder) throws {",
    "        var container = encoder.container(keyedBy: CodingKeys.self)",
    "        switch self {",
    ...union.cases.flatMap((entry) => [
      `        case .${identifier(entry.name)}${casePattern(entry.fields)}:`,
      `            try container.encode(${JSON.stringify(entry.value)}, forKey: .${identifier(union.key)})`,
      ...entry.fields.map((field) => `            ${encodeField(field)}`),
    ]),
    "        }",
    "    }",
  ];
}

function renderUnionJSON(union: Union): string[] {
  return [
    "    var json: JSONValue {",
    "        switch self {",
    ...union.cases.map((entry) => {
      const entries = [
        `${JSON.stringify(union.key)}: .string(${JSON.stringify(entry.value)})`,
        ...[...entry.filled].map(([name, constant]) => `${JSON.stringify(name)}: ${jsonOf(constant, { kind: "int" })}`),
        ...entry.fields.map((field) => sentEntry(field, identifier(field.name))),
      ];
      return `        case .${identifier(entry.name)}${casePattern(entry.fields)}: JSONValue.fields([${entries.join(", ")}])`;
    }),
    "        }",
    "    }",
  ];
}

function renderEnvelope(union: Union): string[] {
  const envelope = union.frame!.envelope.name;
  const patterns = union.cases.map((entry) => `.${identifier(entry.name)}(let ${envelope}${entry.fields.map(() => ", _").join("")})`);
  return [
    `    var ${envelope}: ${fieldType(union.frame!.envelope)} {`,
    "        switch self {",
    `        case ${patterns.join(", ")}:`,
    `            ${envelope}`,
    "        }",
    "    }",
  ];
}

/** A frame's field read from its JSON: a required one that does not read drops the frame, an optional one reads as absent. */
function readValue(field: Field, types: Map<string, Named>): string {
  const value = `object[${JSON.stringify(field.name)}]`;
  const swift = field.swift;
  switch (swift.kind) {
    case "string": return `${value}?.stringValue`;
    case "bool": return `${value}?.boolValue`;
    case "double": return `${value}?.numberValue`;
    case "json": return value;
    case "flag": return `${value} == .bool(true)`;
    case "named":
      if (types.get(swift.name)?.kind === "enum") return `${value}?.stringValue.flatMap(${swift.name}.init(rawValue:))`;
      return `${value}.flatMap({ try? $0.decode(${swift.name}.self) })`;
    case "array": case "map": return `${value}.flatMap({ try? $0.decode(${typeName(swift)}.self) })`;
    case "int": case "result": throw new Error(`${field.key}: a frame has no reading for ${swift.kind}.`);
  }
}

function readCase(field: Field, types: Map<string, Named>): { guard?: string; value: string } {
  const name = identifier(field.name);
  if (field.swift.kind === "result") {
    const { ok, success, failure } = field.swift;
    const guard = `case .bool(let ${ok}) = object[${JSON.stringify(ok)}]`;
    const value = `${ok} ? .success(${readValue(success, types)} ?? ${success.fallback ?? ".null"}) : .failure(.init(${failure.name}: ${readValue(failure, types)} ?? ${failure.fallback ?? "\"\""}))`;
    return { guard, value };
  }
  const read = readValue(field, types);
  if (field.swift.kind === "flag") return { value: read };
  if (field.fallback !== undefined) return { value: `${read} ?? ${field.fallback}` };
  if (field.optional || field.nullable) return { value: read };
  return { guard: `let ${name} = ${read}`, value: name };
}


function renderFrameRead(union: Union): string[] {
  const envelope = union.frame!.envelope;
  const lines = [
    `extension ${union.name} {`,
    `    /// The message a frame of \`${union.key}\` holds, or nil for one this app does not know or a required field that does not read.`,
    `    static func read(${union.key}: String, ${envelope.name}: ${typeName(envelope.swift)}, _ object: [String: JSONValue]) -> ${union.name}? {`,
    `        switch ${union.key} {`,
  ];
  for (const entry of union.cases) {
    const reads = entry.fields.map((field) => ({ field, ...readCase(field, known) }));
    const guards = reads.flatMap((read) => read.guard ? [read.guard] : []);
    const values = [`${envelope.name}: ${envelope.name}`, ...reads.map((read) => `${read.field.name}: ${read.value}`)];
    lines.push(`        case ${JSON.stringify(entry.value)}:`);
    if (guards.length > 0) lines.push(`            guard ${guards.join(", ")} else { return nil }`);
    lines.push(`            return .${identifier(entry.name)}(${values.join(", ")})`);
  }
  lines.push("        default:", "            return nil", "        }", "    }", "}");
  return lines;
}

function renderEnum(enumeration: Named & { kind: "enum" }, uses: Uses): string[] {
  const read = uses.read.has(enumeration.name) || uses.stored.has(enumeration.name) || uses.sent.has(enumeration.name);
  return [
    ...docLines(enumeration.doc, ""),
    `enum ${enumeration.name}: ${conformances(enumeration.name, ["String", ...(read ? ["Codable"] : [])], uses)} {`,
    ...enumeration.values.map((value) => {
      const name = identifier(camelCased(value));
      return camelCased(value) === value ? `    case ${name}` : `    case ${name} = ${JSON.stringify(value)}`;
    }),
    "}",
  ];
}

function renderTable(table: Named & { kind: "table" }): string[] {
  const row = (values: Array<string | number | boolean>) => `${table.name}(${values.map((value, index) => `${table.columns[index]!.name}: ${JSON.stringify(value)}`).join(", ")})`;
  return [
    `/// \`${table.constant}\` in \`${table.file}\`, row by row.`,
    `struct ${table.name}: Equatable, Sendable {`,
    ...table.columns.map((column) => `    var ${identifier(column.name)}: ${typeName(column.swift)}`),
    "",
    `    static let allCases: [${table.name}] = [`,
    ...table.rows.map((values) => `        ${row(values)},`),
    "    ]",
    "}",
  ];
}

function renderStructJSON(struct: Struct): string[] {
  return [
    `extension ${struct.name} {`,
    "    var json: JSONValue {",
    `        JSONValue.fields([${struct.fields.map((field) => sentEntry(field, identifier(field.name))).join(", ")}])`,
    "    }",
    "}",
  ];
}

export function renderTypes(contract: Contract, uses: Uses): string[] {
  known = contract.types;
  const ordered = [...contract.types.values()].sort((left, right) => left.file.localeCompare(right.file) || left.position - right.position);
  const blocks: string[][] = [...contract.constants].map(([name, value]) => [`let ${name} = ${value}`]);
  for (const type of ordered) {
    if (type.kind === "struct") blocks.push(renderStruct(type, "", uses), ...(uses.sent.has(type.name) && !type.patch ? [renderStructJSON(type)] : []));
    if (type.kind === "union") blocks.push(renderUnion(type, uses));
    if (type.kind === "enum") blocks.push(renderEnum(type, uses));
    if (type.kind === "table") blocks.push(renderTable(type));
  }
  return blocks.flatMap((block) => ["", ...block]);
}

export function renderCommands(commands: Command[]): string[] {
  const kinds = commands.map((command) => `        case ${camelCased(command.type)} = ${JSON.stringify(command.type)}`);
  const builders = commands.map((command) => {
    const name = camelCased(command.type);
    const fields = command.fields.map((field) => sentEntry(field, identifier(field.name)));
    const body = fields.length === 0 ? `PhoneCommand(.${name})` : `PhoneCommand(.${name}, [${fields.join(", ")}])`;
    return `    static func ${name}(${command.fields.map(parameter).join(", ")}) -> PhoneCommand { ${body} }`;
  });
  return [
    "",
    "extension PhoneCommand {",
    "    /// Every command a phone may send, by its `type`.",
    "    enum Kind: String, CaseIterable, Sendable {",
    ...kinds,
    "    }",
    "",
    ...builders,
    "}",
  ];
}
