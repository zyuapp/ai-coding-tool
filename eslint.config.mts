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

/** Classes owned by a primitive. Markup elsewhere renders the primitive rather than spelling out its classes. */
const PRIMITIVE_CLASS = /(^|\s)(btn|icon-btn|chip|kbd|kbd-key|text-field(-group|-label|-hint|-error)?|search-field|select|switch|checkbox|segmented|list-row|list-heading|notice|empty-view|dialog|menu-item|menu-group|menu-opener|nav-list)(\s|$)/;
const classAttribute = "JSXAttribute[name.name=/^(className|wrapClassName)$/]";
const PRIMITIVE_MARKUP = [
  { selector: `${classAttribute} Literal[value=${PRIMITIVE_CLASS}]`, message: "Render the primitive from src/renderer/ui instead of writing its class." },
  { selector: `${classAttribute} TemplateElement[value.raw=${PRIMITIVE_CLASS}]`, message: "Render the primitive from src/renderer/ui instead of writing its class." },
  { selector: "JSXOpeningElement[name.name='select']", message: "Use Select from src/renderer/ui/Field." },
  { selector: "JSXAttribute[name.name='role'][value.value='switch']", message: "Use Switch from src/renderer/ui/Field." },
  { selector: "JSXAttribute[name.name='className'] Literal[value=/(^|\\s)(modal-scrim|modal-panel)(\\s|$)/]", message: "Use Dialog from src/renderer/ui/Dialog." },
];

/** The desktop bridge is reached from hooks and modules outside the components, which only draw what they are handed. */
const BRIDGE_ACCESS = [
  { selector: "MemberExpression[object.name='window'][property.name=/^(desktop|workspace)$/]", message: "Reach the desktop from a hook or module outside src/renderer/components and src/renderer/ui." },
];

export default [
  { ignores: ["node_modules/**", "dist/**", "release/**", "vendor/**", "native/dictation/.build/**", "ios/build/**"] },
  { files: ["**/*.ts", "**/*.mts", "**/*.cts"], languageOptions: typescript(false), rules: sizeRules },
  { files: ["**/*.tsx", "**/*.jsx"], languageOptions: typescript(true), rules: sizeRules },
  { files: ["**/*.js", "**/*.mjs", "**/*.cjs"], rules: sizeRules },
  /** A look the app repeats is drawn once, by its primitive in src/renderer/ui, so a change to it reaches every copy. */
  { files: ["src/renderer/**/*.tsx"], ignores: ["src/renderer/ui/**", "src/renderer/components/**"], rules: { "no-restricted-syntax": ["error", ...PRIMITIVE_MARKUP] } },
  { files: ["src/renderer/components/**"], rules: { "no-restricted-syntax": ["error", ...PRIMITIVE_MARKUP, ...BRIDGE_ACCESS] } },
  { files: ["src/renderer/ui/**"], rules: { "no-restricted-syntax": ["error", ...BRIDGE_ACCESS] } },
  /** Tool definitions belong to no host: a second engine must be able to serve them untouched. */
  { files: ["src/main/tools/**"], rules: { "no-restricted-imports": ["error", { paths: [{ name: "@anthropic-ai/claude-agent-sdk", message: "Tool definitions are host-neutral; host them from the engine that serves them." }] }] } },
];
