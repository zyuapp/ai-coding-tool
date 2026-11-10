import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { API, type Checker, type Project, SymbolFlags, type Type, TypeFlags } from "typescript/unstable/sync";
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
  isTypeAliasDeclaration,
  isTypeLiteralNode,
  isTypeReferenceNode,
  isUnionTypeNode,
  type Node,
  SyntaxKind,
  type TypeAliasDeclaration,
  type TypeNode,
} from "typescript/unstable/ast";

/** What the phone decodes as a whole: these and every record they reach are generated. */
const ROOTS = ["MobileView", "MobileThreadRead", "MobileThreadHistory", "MobileVocabulary", "MobileArchivedThread"];

/** Contract types the app writes by hand, by the Swift name they go by. */
const HAND_WRITTEN: Record<string, string> = { MobileLocation: "MobileLocation", DiffRange: "DiffRange", MobileCommand: "PhoneCommand" };

/** Conformances beyond `Codable, Equatable, Sendable`, by Swift struct name. */
const CONFORMANCES: Record<string, string[]> = {
  MobileArchivedThread: ["Identifiable"],
  MobileBackgroundItem: ["Identifiable"],
  MobileDecision: ["Identifiable"],
  MobileMember: ["Identifiable"],
  MobileQueuedMessage: ["Identifiable"],
  MobileRoleTerm: ["Identifiable"],
  MobileSuggestion: ["Identifiable"],
  MobileThreadEntry: ["Identifiable"],
  MobileUsageWindow: ["Identifiable"],
  MobileWorktreeChoice: ["Identifiable"],
};

/** Memberwise-initialiser defaults, by `Struct.field`. */
const DEFAULTS: Record<string, string> = {
  "MobileActivity.priority": "[]",
  "MobileActivity.running": "[]",
  "MobileActivity.threads": "[]",
  "MobileActivity.snoozed": "[]",
};

/** Fields the contract requires that the phone still reads as optional, since older computers leave them out. */
const OPTIONAL_ON_PHONE = new Set(["MobileView.upkeep", "MobileView.dictation", "MobileView.usage"]);

const root = path.resolve(import.meta.dirname, "..");
const projectName = "tsconfig.main.json";
const sourceName = "src/contracts/mobile.ts";
const targetName = "ios/AICodingTool/Protocol/Contract.generated.swift";

const SWIFT_KEYWORDS = new Set(["as", "break", "case", "catch", "class", "continue", "default", "defer", "do", "else", "enum", "extension", "false", "for", "func", "guard", "if", "import", "in", "init", "inout", "internal", "is", "let", "nil", "operator", "private", "protocol", "public", "repeat", "return", "self", "Self", "static", "struct", "subscript", "super", "switch", "throw", "throws", "true", "try", "typealias", "var", "where", "while"]);

type Declaration = TypeAliasDeclaration | InterfaceDeclaration;
/** `name` is qualified by the structs it nests in. */
type Struct = { name: string; doc: string[]; fields: string[]; nested: Struct[]; file: string; position: number };

class ContractError extends Error {}

function generate(project: Project): string {
  const checker: Checker = project.checker;
  const contract = project.program.getSourceFile(path.join(root, sourceName));
  if (!contract) throw new ContractError(`${sourceName} is not in ${projectName}.`);

  const declarations = new Map<string, Declaration>();
  for (const statement of contract.statements) {
    if (isTypeAliasDeclaration(statement) || isInterfaceDeclaration(statement)) declarations.set(statement.name.text, statement);
  }
  const countDeclaration = declarations.get("Count");
  if (!countDeclaration) throw new ContractError(`${sourceName} declares no Count type.`);
  const count = checker.getSymbolAtLocation(countDeclaration.name)?.id;

  const structs = new Map<string, Struct>();
  const used = new Set<string>();

  const resolve = (name: EntityName) => {
    const symbol = checker.getSymbolAtLocation(name);
    if (!symbol) return undefined;
    const target = symbol.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    return { id: target.id, declaration: target.declarations[0]?.resolve(project) };
  };

  const isStringLike = (type: Type): boolean => type.isUnionType()
    ? (type.getTypes() ?? []).every(isStringLike)
    : Boolean(type.flags & TypeFlags.StringLike) || (type.isIntersectionType() && (type.getTypes() ?? []).some(isStringLike));
  const isBooleanLike = (type: Type): boolean => type.isUnionType() ? (type.getTypes() ?? []).every(isBooleanLike) : Boolean(type.flags & TypeFlags.BooleanLike);
  const isRecord = (type: Type): boolean => type.isIntersectionType()
    ? (type.getTypes() ?? []).every(isRecord)
    : Boolean(type.flags & TypeFlags.Object) && !checker.isArrayType(type) && checker.getSignaturesOfType(type, 0).length === 0;

  const docOf = (node: Node): string[] => {
    const text = getTextOfJSDocComment((node.jsDoc ?? []).filter(isJSDoc).at(-1)?.comment) ?? "";
    return text.replace(/\{@link\s+([^}\s]+)\s*\}/g, "`$1`").split("\n").map((line) => line.trim()).filter(Boolean);
  };
  const singular = (name: string): string => name.endsWith("ies") ? `${name.slice(0, -3)}y` : name.endsWith("s") ? name.slice(0, -1) : name;
  const capitalized = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);
  const relative = (node: Node): string => path.relative(root, node.getSourceFile().fileName);

  function build(name: string, type: Type, node: Node): Struct {
    if (checker.getIndexInfosOfType(type).length > 0) throw new ContractError(`${name}: an index signature has no Swift struct.`);
    const struct: Struct = { name, doc: docOf(node), fields: [], nested: [], file: relative(node), position: node.pos };
    used.add(`struct:${name}`);
    for (const property of checker.getPropertiesOfType(type)) {
      const key = `${name}.${property.name}`;
      const declaration = property.valueDeclaration?.resolve(project);
      if (!declaration || !isPropertySignatureDeclaration(declaration) || !declaration.type) throw new ContractError(`${key}: only typed properties map to Swift.`);
      let optional = Boolean(property.flags & SymbolFlags.Optional);
      if (OPTIONAL_ON_PHONE.has(key)) {
        if (optional) throw new ContractError(`${key} is optional already; take it out of OPTIONAL_ON_PHONE.`);
        optional = true;
        used.add(`optional:${key}`);
      }
      let typeNode = unwrap(declaration.type);
      if (isUnionTypeNode(typeNode) && typeNode.types.some(isNullish)) {
        optional = true;
        const present = typeNode.types.filter((member) => !isNullish(member));
        if (present.length === 1) typeNode = unwrap(present[0]!);
      }
      const swift = map(typeNode, key, struct, property.name, false);
      const fallback = DEFAULTS[key];
      if (fallback !== undefined) used.add(`default:${key}`);
      const field = SWIFT_KEYWORDS.has(property.name) ? `\`${property.name}\`` : property.name;
      struct.fields.push(...docOf(declaration).map((line) => `/// ${line}`), `var ${field}: ${swift}${optional ? "?" : ""}${fallback === undefined ? "" : ` = ${fallback}`}`);
    }
    return struct;
  }

  function named(declaration: Declaration): string {
    const name = declaration.name.text;
    if (structs.has(name)) return name;
    if (declaration.typeParameters?.length) throw new ContractError(`${name}: a generic type has no Swift struct.`);
    const placeholder: Struct = { name, doc: [], fields: [], nested: [], file: "", position: 0 };
    structs.set(name, placeholder);
    Object.assign(placeholder, build(name, checker.getTypeAtLocation(declaration.name)!, declaration));
    return name;
  }

  function reference(node: TypeNode | undefined): string | undefined {
    return node && isTypeReferenceNode(node) && isIdentifier(node.typeName) ? node.typeName.text : undefined;
  }

  function map(node: TypeNode, where: string, parent: Struct, property: string, inArray: boolean): string {
    node = unwrap(node);
    if (isArrayTypeNode(node)) return `[${map(node.elementType, where, parent, property, true)}]`;
    if (isTypeLiteralNode(node)) {
      const name = capitalized(inArray ? singular(property) : property);
      const qualified = `${parent.name}.${name}`;
      if (parent.nested.some((nested) => nested.name === qualified)) throw new ContractError(`${where}: ${qualified} is already taken.`);
      parent.nested.push(build(qualified, checker.getTypeFromTypeNode(node)!, node));
      return name;
    }
    if (isTypeReferenceNode(node) && isIdentifier(node.typeName)) {
      const name = node.typeName.text;
      const [first, second] = node.typeArguments ?? [];
      if (HAND_WRITTEN[name]) return HAND_WRITTEN[name];
      if (name === "Array" && first) return `[${map(first, where, parent, property, true)}]`;
      if (name === "Extract" && HAND_WRITTEN[reference(first) ?? ""]) return HAND_WRITTEN[reference(first)!]!;
      if (name === "Partial" && reference(first) === "Record") return map(first!, where, parent, property, inArray);
      if (name === "Record" && first && second) {
        if (!isStringLike(checker.getTypeFromTypeNode(first)!)) throw new ContractError(`${where}: a Record's keys must be strings.`);
        return `[String: ${map(second, where, parent, property, false)}]`;
      }
      const resolved = resolve(node.typeName);
      if (resolved && resolved.id === count) return "Int";
      const declaration = resolved?.declaration;
      if (declaration && (isTypeAliasDeclaration(declaration) || isInterfaceDeclaration(declaration)) && !declaration.getSourceFile().isDeclarationFile) {
        if (isInterfaceDeclaration(declaration)) return named(declaration);
        const body = unwrap(declaration.type);
        if ((isTypeLiteralNode(body) || isIntersectionTypeNode(body)) && isRecord(checker.getTypeAtLocation(declaration.name)!)) return named(declaration);
        if (!declaration.typeParameters) return map(body, where, parent, property, inArray);
      }
    }
    if (node.kind === SyntaxKind.StringKeyword) return "String";
    if (node.kind === SyntaxKind.NumberKeyword) return "Double";
    if (node.kind === SyntaxKind.BooleanKeyword) return "Bool";
    if (isUnionTypeNode(node) && node.types.some(isNullish)) throw new ContractError(`${where}: null is read on a field only, not inside \`${node.getText()}\`.`);
    const type = checker.getTypeFromTypeNode(node)!;
    if (isStringLike(type)) return "String";
    if (isBooleanLike(type)) return "Bool";
    throw new ContractError(`${where}: \`${node.getText()}\` has no Swift mapping.`);
  }

  for (const name of ROOTS) {
    const declaration = declarations.get(name);
    if (!declaration) throw new ContractError(`${sourceName} declares no ${name}.`);
    named(declaration);
  }

  const stale = [
    ...Object.keys(CONFORMANCES).filter((name) => !used.has(`struct:${name}`)).map((name) => `CONFORMANCES.${name}`),
    ...Object.keys(DEFAULTS).filter((key) => !used.has(`default:${key}`)).map((key) => `DEFAULTS["${key}"]`),
    ...[...OPTIONAL_ON_PHONE].filter((key) => !used.has(`optional:${key}`)).map((key) => `OPTIONAL_ON_PHONE "${key}"`),
  ];
  if (stale.length > 0) throw new ContractError(`Configuration names nothing generated: ${stale.join(", ")}.`);

  const ordered = [...structs.values()].sort((left, right) => left.file.localeCompare(right.file) || left.position - right.position);
  const header = [
    `// Generated by scripts/generate-ios-contract.mts from ${sourceName} and the types it names. Do not edit:`,
    "// run npm run generate:ios-contract. Values a newer computer may extend (statuses, engines, models,",
    "// efforts, modes) are kept as strings, so an unknown one is shown as it was sent rather than failing",
    "// the whole view.",
    "",
    "import Foundation",
  ];
  return `${[...header, ...ordered.flatMap((struct) => ["", ...render(struct, "")])].join("\n")}\n`;
}

function render(struct: Struct, indent: string): string[] {
  const inner = `${indent}    `;
  const conformances = ["Codable", "Equatable", ...(CONFORMANCES[struct.name] ?? []), "Sendable"];
  return [
    ...struct.doc.map((line) => `${indent}/// ${line}`),
    `${indent}struct ${struct.name.split(".").at(-1)}: ${conformances.join(", ")} {`,
    ...struct.nested.flatMap((nested) => [...render(nested, inner), ""]),
    ...struct.fields.map((line) => `${inner}${line}`),
    `${indent}}`,
  ];
}

function unwrap(node: TypeNode): TypeNode {
  return isParenthesizedTypeNode(node) ? unwrap(node.type) : node;
}

function isNullish(node: TypeNode): boolean {
  return node.kind === SyntaxKind.UndefinedKeyword || (isLiteralTypeNode(node) && node.literal.kind === SyntaxKind.NullKeyword);
}

function generated(): string {
  const api = new API({ cwd: root });
  try {
    const configFile = path.join(root, projectName);
    const project = api.updateSnapshot({ openProjects: [configFile] }).getProject(configFile);
    if (!project) throw new ContractError(`${projectName} could not be opened.`);
    return generate(project);
  } finally {
    api.close();
  }
}

let written: string;
try {
  written = generated();
} catch (error) {
  if (!(error instanceof ContractError)) throw error;
  console.error(error.message);
  process.exit(1);
}
const target = path.join(root, targetName);
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch {
    // A missing file is stale.
  }
  if (current !== written) {
    console.error(`${targetName} is out of date. Run npm run generate:ios-contract.`);
    process.exit(1);
  }
} else {
  writeFileSync(target, written);
}
