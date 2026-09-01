import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Lint is advisory here: TypeScript's own type-checker is the primary gate.
// We keep ESLint focused on genuine mistakes and turn off the stylistic rules
// that would only generate noise across a freshly-migrated codebase.
export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", ".migration/**"],
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
  {
    // Atlas has completed its strict typing migration. Keep the rest of the
    // incremental TypeScript migration independent, but do not allow these two
    // modules to fall back to explicit `any` as their contracts evolve.
    files: ["assets/js/20-atlas-engine.ts", "assets/js/21-atlas-view.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSAsExpression > TSAsExpression",
          message: "Do not bypass Atlas typing with a chained type assertion; narrow or type the source value instead.",
        },
      ],
    },
  },
);
