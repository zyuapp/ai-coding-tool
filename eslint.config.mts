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

// Files that predate the limits, capped at their current size so they can shrink but never grow.
// Delete an entry once its file fits the limit above.
const fileCaps = {
  "src/application/workspace-reducer.ts": 1769,
  "src/main/main.ts": 1026,
  "src/renderer/components/ConversationTimeline.tsx": 776,
  "tests/claude-agent-provider.test.mts": 633,
  "tests/renderer.test.mts": 4325,
  "tests/workspace-reducer.test.mts": 2138,
};

const functionCaps = {
  "src/application/task-workspace.ts": 162,
  "src/application/workspace-reducer.ts": 1040,
  "src/renderer/App.tsx": 556,
  "src/renderer/components/ConversationTimeline.tsx": 455,
  "src/renderer/components/DiffPanel.tsx": 313,
  "src/renderer/components/ImageAnnotator.tsx": 257,
  "src/renderer/components/ProjectSidebar.tsx": 407,
  "src/renderer/components/SettingsPanel.tsx": 384,
  "src/renderer/components/TaskComposer.tsx": 447,
  "src/renderer/task-workspace/useTaskWorkspace.ts": 547,
  "tests/diff-review.test.mts": 231,
  "tests/diff.test.mts": 203,
  "tests/support/electron-harness.mts": 188,
  "tests/worktrees.test.mts": 308,
};

const sizeRules = {
  "max-lines": maxLines(FILE_MAX),
  "max-lines-per-function": maxLinesPerFunction(FUNCTION_MAX),
};

export default [
  { ignores: ["node_modules/**", "dist/**", "release/**", "vendor/**"] },
  { files: ["**/*.ts", "**/*.mts", "**/*.cts"], languageOptions: typescript(false), rules: sizeRules },
  { files: ["**/*.tsx", "**/*.jsx"], languageOptions: typescript(true), rules: sizeRules },
  { files: ["**/*.js", "**/*.mjs", "**/*.cjs"], rules: sizeRules },

  ...Object.entries(fileCaps).map(([file, max]) => ({ files: [file], rules: { "max-lines": maxLines(max) } })),
  ...Object.entries(functionCaps).map(([file, max]) => ({ files: [file], rules: { "max-lines-per-function": maxLinesPerFunction(max) } })),
];
