import { createHighlighterCoreSync, type HighlighterCore, type ThemedToken, type ThemeRegistrationRaw } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import css from "@shikijs/langs/css";
import go from "@shikijs/langs/go";
import html from "@shikijs/langs/html";
import javascript from "@shikijs/langs/javascript";
import json from "@shikijs/langs/json";
import jsx from "@shikijs/langs/jsx";
import markdown from "@shikijs/langs/markdown";
import python from "@shikijs/langs/python";
import rust from "@shikijs/langs/rust";
import shellscript from "@shikijs/langs/shellscript";
import sql from "@shikijs/langs/sql";
import toml from "@shikijs/langs/toml";
import tsx from "@shikijs/langs/tsx";
import typescript from "@shikijs/langs/typescript";
import yaml from "@shikijs/langs/yaml";

export type { ThemedToken };

const LANGS = [css, go, html, javascript, json, jsx, markdown, python, rust, shellscript, sql, toml, tsx, typescript, yaml];

/**
 * Colours are `var()` rather than hex, so a theme redefines them the way it redefines every other
 * colour in the app. Shiki puts arbitrary values back untouched after tokenizing, which is what makes
 * this work at all.
 */
const THEME = {
  name: "claudex",
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
      langs: LANGS,
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  } catch {
    unavailable = true;
  }
  return highlighter;
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
    return engine.codeToTokens(code, { lang, theme: "claudex" }).tokens;
  } catch {
    return null;
  }
}
