import babelParser from "@babel/eslint-parser";

const FILE_MAX = 700;
const FUNCTION_MAX = 150;

const maxLines = (max: number) => ["error", { max, skipBlankLines: true, skipComments: true }];
const maxLinesPerFunction = (max: number) => ["error", { max, skipBlankLines: true, skipComments: true, IIFEs: true }];

/** Babel parses TypeScript for syntax only. JSX is enabled per extension because `.ts` reads `<T>` as a type assertion. */
const typescript = (jsx: boolean) => ({
  parser: babelParser,
  sourceType: "module",
  parserOptions: {
    requireConfigFile: false,
    babelOptions: {
      presets: ["@babel/preset-typescript"],
      plugins: jsx ? ["@babel/plugin-syntax-jsx"] : [],
    },
  },
});

const sizeRules = {
  "max-lines": maxLines(FILE_MAX),
  "max-lines-per-function": maxLinesPerFunction(FUNCTION_MAX),
};

export default [
  { ignores: ["node_modules/**", "dist/**", "release/**", "vendor/**"] },
  { files: ["**/*.ts", "**/*.mts", "**/*.cts"], languageOptions: typescript(false), rules: sizeRules },
  { files: ["**/*.tsx", "**/*.jsx"], languageOptions: typescript(true), rules: sizeRules },
  { files: ["**/*.js", "**/*.mjs", "**/*.cjs"], rules: sizeRules },
];
