import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Lint is advisory here: TypeScript's own type-checker is the primary gate.
// We keep ESLint focused on genuine mistakes and turn off the stylistic rules
// that would only generate noise across a freshly-migrated codebase.
export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "mockups/**", ".migration/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      // The codebase legitimately uses `cond && fn()` / `a ? b() : c()` as
      // statements and reads `el.offsetHeight` to force reflow.
      "@typescript-eslint/no-unused-expressions": "off",
      "no-empty": "off",
      "no-constant-condition": ["error", { checkLoops: false }],
      "prefer-const": "off",
    },
  },
  {
    // Build/tooling scripts run in Node.
    files: ["scripts/**/*.{js,mjs}", "*.config.{js,ts,mjs}"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        URL: "readonly",
      },
    },
  },
);
