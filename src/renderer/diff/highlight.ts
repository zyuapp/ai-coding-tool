import type { HighlighterCore, LanguageRegistration, ThemedToken, ThemeRegistrationRaw } from "shiki/core";
import { hunkText, hunkTextIndex, languageForPath, type DiffFile } from "../../domain/diff";

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
let built: Promise<void> | null = null;

/**
 * Fetched once, beside the first grammar: the engine is a quarter of a megabyte and a window that
 * never opens a patch never reads a line. Its own build is synchronous, because the JavaScript regex
 * engine needs no WebAssembly, so once it is here a file opens already coloured.
 */
function shiki(): Promise<void> {
  built ??= (async () => {
    try {
      const [{ createHighlighterCoreSync }, { createJavaScriptRegexEngine }] = await Promise.all([
        import("shiki/core"),
        import("shiki/engine/javascript"),
      ]);
      highlighter = createHighlighterCoreSync({
        themes: [THEME],
        langs: [],
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      });
    } catch {
      highlighter = null;
    }
  })();
  return built;
}

/** Registers the grammar a path needs. Resolves either way: a language nothing can read draws plain. */
export async function ensureLanguage(lang: string | null) {
  if (!lang) return;
  let pending = fetched.get(lang);
  if (!pending) {
    const load = GRAMMARS[lang];
    pending = load
      ? Promise.all([shiki(), load()])
        .then(async ([, grammar]) => {
          if (!highlighter) return;
          await highlighter.loadLanguage(grammar.default);
          warm(highlighter, lang);
        })
        .catch(() => undefined)
      : Promise.resolve();
    fetched.set(lang, pending);
  }
  await pending;
}

/**
 * A grammar's first block costs far more than its next one, and the first block a review asks for is
 * one the user is waiting on. So a grammar reads one throwaway line as it registers, beside the patch
 * reads rather than in front of the drawing.
 */
function warm(engine: HighlighterCore, lang: string) {
  try {
    engine.codeToTokens("a", { lang, theme: "aicodingtool" });
  } catch {
    // A grammar that cannot read one line simply draws plain, which the drawing already allows for.
  }
}

/**
 * A block of code as coloured tokens, one array per line. Whole blocks rather than single lines,
 * because a line tokenized alone has lost whatever string or comment opened above it.
 */
/** Past this a block is not worth a grammar: the pause is longer than the colour is useful. */
const HIGHLIGHT_LIMIT = 100_000;

export function highlightBlock(code: string, lang: string | null): ThemedToken[][] | null {
  if (!lang || !code || code.length > HIGHLIGHT_LIMIT) return null;
  const engine = highlighter;
  if (!engine || !engine.getLoadedLanguages().includes(lang)) return null;
  try {
    return engine.codeToTokens(code, { lang, theme: "aicodingtool" }).tokens;
  } catch {
    return null;
  }
}

/**
 * One file's colours, filled a hunk at a time. Colouring a whole review costs seconds of a blocked
 * window, so a hunk is read only when something draws a row from it, and what it gave is kept against
 * the file: scrolling back over lines already coloured costs nothing.
 */
export type FileTokens = {
  /** Which hunk each row came from, so a drawn row names the block that colours it. */
  hunkOf: Map<string, number>;
  /** The colours read so far, by row. A row whose hunk is not read yet is simply absent. */
  tokens: Map<string, ThemedToken[]>;
  /** Reads one hunk, at most once. True when it left something new to draw. */
  colour: (hunk: number) => boolean;
};

export function fileTokens(file: DiffFile): FileTokens {
  const lang = languageForPath(file.path);
  const hunkOf = new Map<string, number>();
  const tokens = new Map<string, ThemedToken[]>();
  const read = new Set<number>();
  for (const [index, hunk] of file.hunks.entries()) {
    for (const row of hunk.rows) hunkOf.set(row.key, index);
  }

  const colour = (index: number) => {
    const hunk = file.hunks[index];
    if (!lang || !hunk || read.has(index)) return false;
    read.add(index);
    let drew = false;
    /**
     * A side is only read for the lines that are its own: context reads the same either way, and a
     * hunk that took nothing away, or added nothing, is most hunks. Each read carries the grammar's
     * own start-up cost, so halving the reads halves what a screen of lines costs to colour.
     */
    const sides = [
      ...hunk.rows.some((row) => row.kind === "delete") ? ["old" as const] : [],
      ...hunk.rows.some((row) => row.kind === "add") || hunk.rows.every((row) => row.kind === "context") ? ["new" as const] : [],
    ];
    for (const side of sides) {
      const lines = highlightBlock(hunkText(hunk, side), lang);
      if (!lines) continue;
      for (const [key, line] of hunkTextIndex(hunk, side)) {
        const drawn = lines[line];
        if (!drawn) continue;
        tokens.set(key, drawn);
        drew = true;
      }
    }
    return drew;
  };

  return { hunkOf, tokens, colour };
}
