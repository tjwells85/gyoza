import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier";

/** @type {import('eslint').Linter.Config[]} */
export const baseConfig = defineConfig([
  // Global ignores - must be first
  // globalIgnores([]),

  // JavaScript/TypeScript files
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    plugins: {
      js,
    },
    extends: ["js/recommended"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      "prefer-const": "error",
    },
  },

  // TypeScript-specific config
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    rules: {
      ...(config.rules || {}),
      // Allow unused vars/imports if prefixed with underscore
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/ban-ts-comment": "off",
    },
  })),

  // Prettier (must be last to override formatting rules)
  eslintConfigPrettier,
]);

export default baseConfig;
