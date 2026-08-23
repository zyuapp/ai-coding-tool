import { createHighlighterCoreSync, type HighlighterCore, type LanguageRegistration, type ThemedToken, type ThemeRegistrationRaw } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

export type { ThemedToken };

/**
 * A grammar is a few hundred kilobytes and most reviews touch two or three languages, so each one is
 * fetched the first time a file asks for it rather than bundled into the window. {@link ensureLanguage}
 * is awaited alongside the patch it is for, which keeps the colouring itself synchronous: by the time
 * there are lines to draw, the grammar that reads them is already registered.
 */
const GRAMMARS: Record<string, () => Promise<{ default: LanguageRegistration[] }>> = {
  css: () => import("@shikijs/langs/css"),
  go: () => import("@shikijs/langs/go"),
  html: () => import("@shikijs/langs/html"),
  javascript: () => import("@shikijs/langs/javascript"),
  json: () => import("@shikijs/langs/json"),
  jsx: () => import("@shikijs/langs/jsx"),
  markdown: () => import("@shikijs/langs/markdown"),
  python: () => import("@shikijs/langs/python"),
  rust: () => import("@shikijs/langs/rust"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  sql: () => import("@shikijs/langs/sql"),
  toml: () => import("@shikijs/langs/toml"),
  tsx: () => import("@shikijs/langs/tsx"),
  typescript: () => import("@shikijs/langs/typescript"),
  yaml: () => import("@shikijs/langs/yaml"),
};

/** The languages already asked for, so a second file of the same kind waits on the first's fetch. */
const fetched = new Map<string, Promise<void>>();

/**
 * Colours are `var()` rather than hex, so a theme redefines them the way it redefines every other
 * colour in the app. Shiki puts arbitrary values back untouched after tokenizing, which is what makes
 * this work at all.
 */
const THEME = {
  name: "aicodingtool",
  type: "dark",
  fg: "var(--code-ink)",
  bg: "transparent",
  settings: [
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "var(--syntax-comment)" } },
    { scope: ["string", "string.quoted", "string.template", "meta.embedded.line"], settings: { foreground: "var(--syntax-string)" } },
    { scope: ["constant.numeric", "constant.language.boolean", "constant.language.null"], settings: { foreground: "var(--syntax-number)" } },
    { scope: ["constant", "constant.character.escape", "constant.other"], settings: { foreground: "var(--syntax-constant)" } },
    { scope: ["keyword", "keyword.control", "storage", "storage.type", "storage.modifier"], settings: { foreground: "var(--syntax-keyword)" } },
    { scope: ["keyword.operator"], settings: { foreground: "var(--syntax-operator)" } },
    { scope: ["entity.name.function", "support.function", "meta.function-call.generic"], settings: { foreground: "var(--syntax-function)" } },
    { scope: ["entity.name.type", "entity.name.class", "entity.other.inherited-class", "support.type", "support.class"], settings: { foreground: "var(--syntax-type)" } },
    { scope: ["variable", "variable.parameter", "meta.definition.variable"], settings: { foreground: "var(--syntax-variable)" } },
    { scope: ["entity.name.tag"], settings: { foreground: "var(--syntax-tag)" } },
    { scope: ["entity.other.attribute-name", "support.type.property-name"], settings: { foreground: "var(--syntax-attribute)" } },
    { scope: ["punctuation", "meta.brace"], settings: { foreground: "var(--syntax-punctuation)" } },
  ],
} satisfies ThemeRegistrationRaw;

let highlighter: HighlighterCore | null = null;
let unavailable = false;

/**
 * Built once, synchronously: the JavaScript regex engine needs no WebAssembly, so a file opens
 * already coloured rather than repainting a moment later.
 */
function shiki() {
  if (highlighter || unavailable) return highlighter;
  try {
    highlighter = createHighlighterCoreSync({
      themes: [THEME],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  } catch {
    unavailable = true;
  }
  return highlighter;
}

/** Registers the grammar a path needs. Resolves either way: a language nothing can read draws plain. */
export async function ensureLanguage(lang: string | null) {
  const engine = lang ? shiki() : null;
  if (!lang || !engine || engine.getLoadedLanguages().includes(lang)) return;
  let pending = fetched.get(lang);
  if (!pending) {
    const load = GRAMMARS[lang];
    pending = load
      ? load().then((grammar) => engine.loadLanguage(grammar.default)).then(() => undefined).catch(() => undefined)
      : Promise.resolve();
    fetched.set(lang, pending);
  }
  await pending;
}

/**
 * A block of code as coloured tokens, one array per line. Whole blocks rather than single lines,
 * because a line tokenized alone has lost whatever string or comment opened above it.
 */
/** Past this a block is not worth a grammar: the pause is longer than the colour is useful. */
const HIGHLIGHT_LIMIT = 100_000;

export function highlightBlock(code: string, lang: string | null): ThemedToken[][] | null {
  if (!lang || !code || code.length > HIGHLIGHT_LIMIT) return null;
  const engine = shiki();
  if (!engine || !engine.getLoadedLanguages().includes(lang)) return null;
  try {
    return engine.codeToTokens(code, { lang, theme: "aicodingtool" }).tokens;
  } catch {
    return null;
  }
}
