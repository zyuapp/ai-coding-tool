import path from "node:path";
import { type Checker, type Project, SymbolFlags, type Symbol as TypeSymbol, type Type, TypeFlags, type TypeReference } from "typescript/unstable/sync";
import {
  type EntityName,
  getTextOfJSDocComment,
  type InterfaceDeclaration,
  isArrayTypeNode,
  isIdentifier,
  isInterfaceDeclaration,
  isIntersectionTypeNode,
  isJSDoc,
  isLiteralTypeNode,
  isParenthesizedTypeNode,
  isPropertySignatureDeclaration,
  isStringLiteral,
  isTypeAliasDeclaration,
  isTypeLiteralNode,
  isTypeReferenceNode,
  isUnionTypeNode,
  isVariableStatement,
  type Node,
  type PropertySignatureDeclaration,
  SyntaxKind,
  type TypeAliasDeclaration,
  type TypeNode,
} from "typescript/unstable/ast";

/** How a contract value reads in Swift. `flag` is the literal `true`, sent only when set. */
export type Swift =
  | { kind: "string" | "bool" | "flag" | "double" | "int" | "json" }
  | { kind: "named"; name: string }
  | { kind: "array"; element: Swift }
  | { kind: "map"; value: Swift }
  | { kind: "result"; ok: string; success: Field; failure: Field };

/** `key` is how the configuration names it: `Owner.field`, `Union.case.field` or `command.type.field`. */
export type Field = { name: string; key: string; swift: Swift; optional: boolean; nullable: boolean; doc: string[]; fallback?: string; patch?: "field" | "value" };

type Placed = { name: string; doc: string[]; file: string; position: number };
export type Struct = Placed & { kind: "struct"; fields: Field[]; nested: Struct[]; patch?: { target: string; handApplied: Set<string> } };
/** `filled` are the fields the app fills itself, by the constant it fills them with. */
export type Case = { name: string; value: string; fields: Field[]; filled: Map<string, string> };
export type Union = Placed & { kind: "union"; key: string; cases: Case[]; fallback?: string; frame?: { envelope: Field } };
export type Enumeration = Placed & { kind: "enum"; values: string[] };
/** A constant list of records, each value a literal, rendered as a Swift struct with every row. */
export type Table = Placed & { kind: "table"; constant: string; columns: Array<{ name: string; swift: Swift }>; rows: Array<Array<string | number | boolean>> };
export type Named = Struct | Union | Enumeration | Table;
export type Command = { type: string; fields: Field[] };

export type Config = {
  source: string;
  read: string[];
  sent: string[];
  commands: string;
  handWritten: Record<string, string>;
  enums: string[];
  discriminators: string[];
  patches: Record<string, string>;
  handApplied: string[];
  frames: Record<string, string>;
  results: Record<string, { ok: string; success: string; failure: string }>;
  fallbacks: Record<string, string>;
  defaults: Record<string, string>;
  optionalOnPhone: string[];
  integers: string[];
  ignored: string[];
  unsent: string[];
  filled: Record<string, string>;
  tables: Record<string, { source: string; constant: string }>;
  constants: Record<string, string>;
};

/** `read` and `sent` are the roots by their Swift names. */
/** `constants` are whole numbers the contract declares, by the Swift name that carries them. */
export type Contract = { types: Map<string, Named>; commands: Command[]; read: string[]; sent: string[]; constants: Map<string, number> };

export class ContractError extends Error {}

type Declaration = TypeAliasDeclaration | InterfaceDeclaration;
type Container = { name: string; nested: Struct[] };

const SWIFT_KEYWORDS = new Set(["as", "break", "case", "catch", "class", "continue", "default", "defer", "do", "else", "enum", "extension", "false", "for", "func", "guard", "if", "import", "in", "init", "inout", "internal", "is", "let", "nil", "operator", "private", "protocol", "public", "repeat", "return", "self", "Self", "static", "struct", "subscript", "super", "switch", "throw", "throws", "true", "try", "typealias", "var", "where", "while"]);

export function identifier(name: string): string {
  return SWIFT_KEYWORDS.has(name) ? `\`${name}\`` : name;
}

/** `task.dismiss-all` as `taskDismissAll`. */
export function camelCased(value: string): string {
  return value.split(/[.\-_\s]+/).filter(Boolean).map((word, index) => index === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)).join("");
}

function unwrap(node: TypeNode): TypeNode {
  return isParenthesizedTypeNode(node) ? unwrap(node.type) : node;
}

function isNullish(node: TypeNode): boolean {
  return node.kind === SyntaxKind.UndefinedKeyword || (isLiteralTypeNode(node) && node.literal.kind === SyntaxKind.NullKeyword);
}

const capitalized = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);
const singular = (name: string): string => name.endsWith("ies") ? `${name.slice(0, -3)}y` : name.endsWith("s") ? name.slice(0, -1) : name;

/** Reads the contract's types into what the Swift is rendered from, failing on anything it has no rule for. */
export class Reader {
  readonly types = new Map<string, Named>();
  readonly used = new Set<string>();
  private readonly checker: Checker;
  private readonly declarations = new Map<string, Declaration>();
  private readonly count: number | undefined;
  private readonly project: Project;
  private readonly root: string;
  private readonly config: Config;

  constructor(project: Project, root: string, config: Config) {
    this.project = project;
    this.root = root;
    this.config = config;
    this.checker = project.checker;
    const contract = project.program.getSourceFile(path.join(root, config.source));
    if (!contract) throw new ContractError(`${config.source} is not in the project.`);
    for (const statement of contract.statements) {
      if (isTypeAliasDeclaration(statement) || isInterfaceDeclaration(statement)) this.declarations.set(statement.name.text, statement);
    }
    const count = this.declarations.get("Count");
    if (!count) throw new ContractError(`${config.source} declares no Count type.`);
    this.count = this.checker.getSymbolAtLocation(count.name)?.id;
  }

  read(): Contract {
    const read = this.config.read.map((name) => this.named(this.declaration(name)));
    const sent = this.config.sent.map((name) => this.named(this.declaration(name)));
    const commands = this.commands(this.declaration(this.config.commands));
    for (const [name, { source, constant }] of Object.entries(this.config.tables)) this.table(name, source, constant);
    return { types: this.types, commands, read, sent, constants: this.constants() };
  }

  /** `as const` keeps every value a literal the checker can read without running the module. */
  private table(name: string, source: string, constant: string): void {
    const file = this.project.program.getSourceFile(path.join(this.root, source));
    const variable = file?.statements.filter(isVariableStatement).flatMap((statement) => [...statement.declarationList.declarations]).find((declaration) => isIdentifier(declaration.name) && declaration.name.text === constant);
    if (!variable) throw new ContractError(`TABLES.${name}: ${source} declares no ${constant}.`);
    const type = this.checker.getTypeAtLocation(variable.name)!;
    if (!this.checker.isTupleType(type)) throw new ContractError(`TABLES.${name}: ${constant} must be an \`as const\` array.`);
    const table: Table = { kind: "table", ...this.placed(name, variable.parent.parent), constant, columns: [], rows: [] };
    for (const row of this.checker.getTypeArguments(type as TypeReference)) {
      const values: Array<string | number | boolean> = [];
      for (const property of this.checker.getPropertiesOfType(row)) {
        const value = this.checker.getTypeOfSymbol(property);
        if (!value?.isLiteralType() || typeof value.value === "bigint") throw new ContractError(`TABLES.${name}: ${constant}.${property.name} is not a literal.`);
        const swift: Swift = typeof value.value === "string" ? { kind: "string" } : typeof value.value === "boolean" ? { kind: "bool" } : Number.isInteger(value.value) ? { kind: "int" } : { kind: "double" };
        if (table.rows.length === 0) table.columns.push({ name: property.name, swift });
        else if (table.columns[values.length]?.name !== property.name) throw new ContractError(`TABLES.${name}: every row of ${constant} has the same fields.`);
        values.push(value.value);
      }
      table.rows.push(values);
    }
    this.types.set(name, table);
  }

  private constants(): Map<string, number> {
    const file = this.project.program.getSourceFile(path.join(this.root, this.config.source))!;
    const variables = file.statements.filter(isVariableStatement).flatMap((statement) => [...statement.declarationList.declarations]);
    const constants = new Map<string, number>();
    for (const [swift, constant] of Object.entries(this.config.constants)) {
      const variable = variables.find((declaration) => isIdentifier(declaration.name) && declaration.name.text === constant);
      const value = variable && this.checker.getTypeAtLocation(variable.name);
      if (!value?.isNumberLiteralType() || !Number.isInteger(value.value)) throw new ContractError(`CONSTANTS.${swift}: ${this.config.source} declares no whole number ${constant}.`);
      constants.set(swift, value.value);
    }
    return constants;
  }

  private declaration(name: string): Declaration {
    const declaration = this.declarations.get(name);
    if (!declaration) throw new ContractError(`${this.config.source} declares no ${name}.`);
    return declaration;
  }

  private docOf(node: Node): string[] {
    const text = getTextOfJSDocComment((node.jsDoc ?? []).filter(isJSDoc).at(-1)?.comment) ?? "";
    return text.replace(/\{@link\s+([^}\s]+)\s*\}/g, "`$1`").split("\n").map((line) => line.trim()).filter(Boolean);
  }

  private placed(name: string, node: Node): Placed {
    return { name, doc: this.docOf(node), file: path.relative(this.root, node.getSourceFile().fileName), position: node.pos };
  }

  private use(kind: string, key: string): boolean {
    this.used.add(`${kind}:${key}`);
    return true;
  }

  private has(list: string[], kind: string, key: string): boolean {
    return list.includes(key) && this.use(kind, key);
  }

  private isStringLike(type: Type): boolean {
    return type.isUnionType()
      ? (type.getTypes() ?? []).every((member) => this.isStringLike(member))
      : Boolean(type.flags & TypeFlags.StringLike) || (type.isIntersectionType() && (type.getTypes() ?? []).some((member) => this.isStringLike(member)));
  }

  private isBooleanLike(type: Type): boolean {
    return type.isUnionType() ? (type.getTypes() ?? []).every((member) => this.isBooleanLike(member)) : Boolean(type.flags & TypeFlags.BooleanLike);
  }

  private isWholeNumbers(type: Type): boolean {
    const members = type.isUnionType() ? type.getTypes() ?? [] : [type];
    return members.every((member) => member.isNumberLiteralType() && Number.isInteger(member.value));
  }

  private isRecord(type: Type): boolean {
    return type.isIntersectionType()
      ? (type.getTypes() ?? []).every((member) => this.isRecord(member))
      : Boolean(type.flags & TypeFlags.Object) && !this.checker.isArrayType(type) && this.checker.getSignaturesOfType(type, 0).length === 0;
  }

  private isObjectUnion(type: Type): boolean {
    return type.isUnionType() && (type.getTypes() ?? []).every((member) => this.isRecord(member));
  }

  private resolve(name: EntityName) {
    const symbol = this.checker.getSymbolAtLocation(name);
    if (!symbol) return undefined;
    const target = symbol.flags & SymbolFlags.Alias ? this.checker.getAliasedSymbol(symbol) : symbol;
    return { id: target.id, declaration: target.declarations[0]?.resolve(this.project) };
  }

  private signature(property: TypeSymbol, key: string): PropertySignatureDeclaration & { type: TypeNode } {
    const declaration = (property.valueDeclaration ?? property.declarations[0])?.resolve(this.project);
    if (!declaration || !isPropertySignatureDeclaration(declaration) || !declaration.type) throw new ContractError(`${key}: only typed properties map to Swift.`);
    return declaration as PropertySignatureDeclaration & { type: TypeNode };
  }

  /** One property as a field, or undefined when the configuration leaves it out. */
  field(property: TypeSymbol, key: string, parent: Container): Field | undefined {
    if (this.has(this.config.ignored, "ignored", key) || this.has(this.config.unsent, "unsent", key)) return undefined;
    const declaration = this.signature(property, key);
    let optional = Boolean(property.flags & SymbolFlags.Optional);
    let nullable = false;
    if (this.config.optionalOnPhone.includes(key)) {
      if (optional) throw new ContractError(`${key} is optional already; take it out of OPTIONAL_ON_PHONE.`);
      optional = this.use("optional", key);
    }
    let typeNode = unwrap(declaration.type);
    if (isUnionTypeNode(typeNode) && typeNode.types.some(isNullish)) {
      nullable = typeNode.types.some((member) => isLiteralTypeNode(member) && member.literal.kind === SyntaxKind.NullKeyword);
      optional ||= typeNode.types.some((member) => member.kind === SyntaxKind.UndefinedKeyword);
      const present = typeNode.types.filter((member) => !isNullish(member));
      if (present.length === 1) typeNode = unwrap(present[0]!);
    }
    const swift = this.map(typeNode, key, parent, property.name, false);
    const fallback = this.config.defaults[key];
    if (fallback !== undefined) this.use("default", key);
    return { name: property.name, key, swift, optional, nullable, doc: this.docOf(declaration), fallback };
  }

  private struct(name: string, type: Type, node: Node): Struct {
    if (this.checker.getIndexInfosOfType(type).length > 0) throw new ContractError(`${name}: an index signature has no Swift struct.`);
    const struct: Struct = { kind: "struct", ...this.placed(name, node), fields: [], nested: [] };
    this.use("struct", name);
    for (const property of this.checker.getPropertiesOfType(type)) {
      const field = this.field(property, `${name}.${property.name}`, struct);
      if (field) struct.fields.push(field);
    }
    return struct;
  }

  private named(declaration: Declaration): string {
    const name = declaration.name.text;
    if (this.types.has(name)) return name;
    if (declaration.typeParameters?.length) throw new ContractError(`${name}: a generic type has no Swift type.`);
    const body = isTypeAliasDeclaration(declaration) ? unwrap(declaration.type) : undefined;
    if (body && isTypeReferenceNode(body)) {
      const swift = this.map(body, name, { name, nested: [] }, name, false);
      if (swift.kind !== "named") throw new ContractError(`${name}: a root names a generated type.`);
      return swift.name;
    }
    const type = this.checker.getTypeAtLocation(declaration.name)!;
    if (this.config.enums.includes(name)) return this.enumeration(name, type, declaration);
    if (this.isObjectUnion(type)) return this.union(name, type, declaration);
    const placeholder: Struct = { kind: "struct", name, doc: [], fields: [], nested: [], file: "", position: 0 };
    this.types.set(name, placeholder);
    Object.assign(placeholder, this.struct(name, type, declaration));
    const target = this.config.patches[name];
    if (target !== undefined) this.patch(placeholder, target);
    return name;
  }

  private enumeration(name: string, type: Type, declaration: Declaration): string {
    this.use("enum", name);
    const members = type.isUnionType() ? type.getTypes() ?? [] : [type];
    if (!members.every((member) => member.isStringLiteralType())) throw new ContractError(`${name}: only a union of strings is a Swift enum.`);
    this.types.set(name, { kind: "enum", ...this.placed(name, declaration), values: members.map((member) => String(member.value)).sort() });
    return name;
  }

  /** The discriminator a union's members each fix to a string. */
  private discriminator(name: string, members: readonly Type[]): string {
    const key = this.config.discriminators.find((candidate) => members.every((member) => this.literal(member, candidate) !== undefined));
    if (!key) throw new ContractError(`${name}: a union's members must each fix one of ${this.config.discriminators.join(", ")} to a string.`);
    return key;
  }

  private literal(member: Type, key: string): { value: string; position: number } | undefined {
    const property = this.checker.getPropertyOfType(member, key);
    const declaration = (property?.valueDeclaration ?? property?.declarations[0])?.resolve(this.project);
    if (!declaration || !isPropertySignatureDeclaration(declaration) || !declaration.type) return undefined;
    const node = unwrap(declaration.type);
    return isLiteralTypeNode(node) && isStringLiteral(node.literal) ? { value: node.literal.text, position: declaration.pos } : undefined;
  }

  /** Members sharing a discriminator value are one case, holding every field any of them has; one only some have is optional. */
  private union(name: string, type: Type, declaration: Declaration): string {
    const union: Union = { kind: "union", ...this.placed(name, declaration), key: "", cases: [] };
    this.types.set(name, union);
    const members = type.isUnionType() ? type.getTypes() : [];
    const container: Container = { name, nested: [] };
    union.key = this.discriminator(name, members);
    const envelope = this.config.frames[name];
    const groups = new Map<string, { position: number; members: Type[] }>();
    for (const member of members) {
      const { value, position } = this.literal(member, union.key)!;
      const group = groups.get(value) ?? { position, members: [] };
      group.members.push(member);
      group.position = Math.min(group.position, position);
      groups.set(value, group);
    }
    for (const [value, group] of [...groups].sort((left, right) => left[1].position - right[1].position)) {
      union.cases.push({ name: camelCased(value), value, fields: this.caseFields(`${name}.${value}`, group.members, container, union.key, envelope), filled: this.filled(name, group.members) });
    }
    if (envelope !== undefined) union.frame = { envelope: this.envelope(name, members[0]!, envelope, container) };
    if (container.nested.length > 0) throw new ContractError(`${name}: name the shape of ${container.nested[0]!.name} so Swift can name it.`);
    const fallback = this.config.fallbacks[name];
    if (fallback !== undefined) {
      if (!groups.has(fallback)) throw new ContractError(`FALLBACKS.${name}: ${name} has no case "${fallback}".`);
      union.fallback = fallback;
      this.use("fallback", name);
    }
    return name;
  }

  private filled(name: string, members: Type[]): Map<string, string> {
    const filled = new Map<string, string>();
    for (const property of members.flatMap((member) => this.checker.getPropertiesOfType(member))) {
      const constant = this.config.filled[`${name}.${property.name}`];
      if (constant !== undefined && this.use("filled", `${name}.${property.name}`)) filled.set(property.name, constant);
    }
    return filled;
  }

  private envelope(name: string, member: Type, envelope: string, parent: Container): Field {
    this.use("frame", name);
    const property = this.checker.getPropertyOfType(member, envelope);
    if (!property) throw new ContractError(`FRAMES.${name}: its members carry no ${envelope}.`);
    return this.field(property, `${name}.${envelope}`, parent)!;
  }

  private caseFields(prefix: string, members: Type[], parent: Container, discriminator: string, envelope: string | undefined): Field[] {
    const fields: Field[] = [];
    const seen = new Map<string, number>();
    for (const member of members) {
      for (const property of this.checker.getPropertiesOfType(member)) {
        if (property.name === discriminator || property.name === envelope || this.config.filled[`${parent.name}.${property.name}`] !== undefined) continue;
        seen.set(property.name, (seen.get(property.name) ?? 0) + 1);
        if (fields.some((field) => field.name === property.name)) {
          const again = this.field(property, `${prefix}.${property.name}`, parent);
          const first = fields.find((field) => field.name === property.name)!;
          if (again) first.swift = this.merged(first.swift, again.swift, first.key);
          continue;
        }
        const field = this.field(property, `${prefix}.${property.name}`, parent);
        if (field) fields.push(field);
      }
    }
    for (const field of fields) if ((seen.get(field.name) ?? 0) < members.length) field.optional = true;
    return this.withResult(prefix, fields);
  }

  private merged(left: Swift, right: Swift, key: string): Swift {
    const bool = (swift: Swift) => swift.kind === "bool" || swift.kind === "flag";
    if (bool(left) && bool(right)) return left.kind === right.kind ? left : { kind: "bool" };
    if (JSON.stringify(left) !== JSON.stringify(right)) throw new ContractError(`${key}: the union's members give it different types.`);
    return left;
  }

  /** A case whose `ok` decides between a value and a failure's message, read as a Swift `Result`. */
  private withResult(prefix: string, fields: Field[]): Field[] {
    const result = this.config.results[prefix];
    if (!result) return fields;
    this.use("result", prefix);
    const take = (name: string) => {
      const field = fields.find((candidate) => candidate.name === name);
      if (!field) throw new ContractError(`RESULTS["${prefix}"]: the case has no ${name}.`);
      return field;
    };
    const ok = take(result.ok);
    const success = take(result.success);
    const failure = take(result.failure);
    const kept = fields.filter((field) => field !== ok && field !== success && field !== failure);
    return [...kept, { name: result.success, key: success.key, swift: { kind: "result", ok: ok.name, success, failure }, optional: false, nullable: false, doc: [] }];
  }

  /** A patch's own fields keep their optionality; one it takes from its target through `Partial` is a `PatchField`. */
  private patch(struct: Struct, target: string): void {
    this.use("patch", struct.name);
    const goal = this.types.get(target);
    if (goal?.kind !== "struct") throw new ContractError(`PATCHES.${struct.name}: ${target} is not a generated struct.`);
    const handApplied = new Set<string>();
    for (const field of struct.fields) {
      const declaration = this.signature(this.checker.getPropertyOfType(this.checker.getTypeAtLocation(this.declaration(struct.name).name)!, field.name)!, field.key);
      const through = this.declaredIn(declaration) === target;
      const own = goal.fields.find((candidate) => candidate.name === field.name);
      if (through) field.patch = own && (own.optional || own.nullable) ? "field" : "value";
      else if (field.optional && field.nullable) field.patch = "field";
      if (this.has(this.config.handApplied, "applied", field.key)) handApplied.add(field.name);
      else if (!own || !sameBase(own.swift, field.swift)) throw new ContractError(`${field.key} has no field of its type on ${target}; list it in HAND_APPLIED.`);
    }
    struct.patch = { target, handApplied };
  }

  private declaredIn(node: Node): string | undefined {
    for (let parent = node.parent; parent; parent = parent.parent) if (isTypeAliasDeclaration(parent) || isInterfaceDeclaration(parent)) return parent.name.text;
    return undefined;
  }

  private commands(declaration: Declaration): Command[] {
    const type = this.checker.getTypeAtLocation(declaration.name)!;
    const commands: Command[] = [];
    for (const member of type.isUnionType() ? type.getTypes() ?? [] : [type]) {
      const literal = this.literal(member, "type");
      if (!literal) throw new ContractError(`${declaration.name.text}: every command names its type.`);
      const container: Container = { name: literal.value, nested: [] };
      const fields = this.checker.getPropertiesOfType(member).filter((property) => property.name !== "type")
        .map((property) => this.field(property, `${literal.value}.${property.name}`, container)).filter((field) => field !== undefined);
      if (container.nested.length > 0) throw new ContractError(`${literal.value}: name the shape of ${container.nested[0]!.name} so the phone can send it.`);
      for (const field of fields) if (field.optional && field.nullable) throw new ContractError(`${field.key}: a command field may be absent or null, not both.`);
      commands.push({ type: literal.value, fields });
    }
    return commands.sort((left, right) => left.type.localeCompare(right.type));
  }

  private reference(node: TypeNode | undefined): string | undefined {
    return node && isTypeReferenceNode(node) && isIdentifier(node.typeName) ? node.typeName.text : undefined;
  }

  private map(node: TypeNode, where: string, parent: Container, property: string, inArray: boolean): Swift {
    node = unwrap(node);
    if (isArrayTypeNode(node)) return { kind: "array", element: this.map(node.elementType, where, parent, property, true) };
    if (isTypeLiteralNode(node)) {
      const name = capitalized(inArray ? singular(property) : property);
      const qualified = `${parent.name}.${name}`;
      if (parent.nested.some((nested) => nested.name === qualified)) throw new ContractError(`${where}: ${qualified} is already taken.`);
      parent.nested.push(this.struct(qualified, this.checker.getTypeFromTypeNode(node)!, node));
      return { kind: "named", name };
    }
    if (isTypeReferenceNode(node) && isIdentifier(node.typeName)) {
      const mapped = this.mapReference(node, where, parent, property, inArray);
      if (mapped) return mapped;
    }
    if (node.kind === SyntaxKind.StringKeyword) return { kind: "string" };
    if (node.kind === SyntaxKind.NumberKeyword) return this.has(this.config.integers, "integer", where) ? { kind: "int" } : { kind: "double" };
    if (node.kind === SyntaxKind.BooleanKeyword) return { kind: "bool" };
    if (node.kind === SyntaxKind.UnknownKeyword) return { kind: "json" };
    if (isLiteralTypeNode(node) && node.literal.kind === SyntaxKind.TrueKeyword) return { kind: "flag" };
    if (isUnionTypeNode(node) && node.types.some(isNullish)) throw new ContractError(`${where}: null is read on a field only, not inside \`${node.getText()}\`.`);
    const type = this.checker.getTypeFromTypeNode(node)!;
    if (this.isStringLike(type)) return { kind: "string" };
    if (this.isBooleanLike(type)) return { kind: "bool" };
    if (this.isWholeNumbers(type)) return { kind: "int" };
    if (this.isObjectUnion(type)) throw new ContractError(`${where}: name the union \`${node.getText()}\` so Swift can name it.`);
    throw new ContractError(`${where}: \`${node.getText()}\` has no Swift mapping.`);
  }

  private mapReference(node: TypeNode, where: string, parent: Container, property: string, inArray: boolean): Swift | undefined {
    if (!isTypeReferenceNode(node) || !isIdentifier(node.typeName)) return undefined;
    const name = node.typeName.text;
    const [first, second] = node.typeArguments ?? [];
    const hand = this.config.handWritten[name];
    if (hand) {
      this.use("hand", name);
      return { kind: "named", name: hand };
    }
    if (name === "Array" && first) return { kind: "array", element: this.map(first, where, parent, property, true) };
    if (name === "Extract" && first) {
      const whole = this.map(first, where, parent, property, inArray);
      if (whole.kind === "named") return whole;
    }
    if (name === "Partial" && this.reference(first) === "Record") return this.map(first!, where, parent, property, inArray);
    if (name === "Record" && first && second) {
      if (!this.isStringLike(this.checker.getTypeFromTypeNode(first)!)) throw new ContractError(`${where}: a Record's keys must be strings.`);
      return { kind: "map", value: this.map(second, where, parent, property, false) };
    }
    const resolved = this.resolve(node.typeName);
    if (resolved && resolved.id === this.count) return { kind: "int" };
    const declaration = resolved?.declaration;
    if (!declaration || !(isTypeAliasDeclaration(declaration) || isInterfaceDeclaration(declaration)) || declaration.getSourceFile().isDeclarationFile) return undefined;
    if (isInterfaceDeclaration(declaration)) return { kind: "named", name: this.named(declaration) };
    const body = unwrap(declaration.type);
    if (isTypeReferenceNode(body)) return this.map(body, where, parent, property, inArray);
    const type = this.checker.getTypeAtLocation(declaration.name)!;
    if (this.config.enums.includes(declaration.name.text) || this.isObjectUnion(type)) return { kind: "named", name: this.named(declaration) };
    if ((isTypeLiteralNode(body) || isIntersectionTypeNode(body)) && this.isRecord(type)) return { kind: "named", name: this.named(declaration) };
    if (!declaration.typeParameters) return this.map(body, where, parent, property, inArray);
    return undefined;
  }
}

export function sameBase(left: Swift, right: Swift): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
