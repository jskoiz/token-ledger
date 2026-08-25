import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";

const recommendedRules = {
  ...js.configs.recommended.rules,
  // Terminal renderers match and strip ANSI escapes by design.
  "no-control-regex": "off",
  "no-regex-spaces": "off",
};

export default defineConfig([
  globalIgnores(["node_modules/**", "outputs/**"]),
  {
    files: ["**/*.mjs", "**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        Buffer: "readonly",
        process: "readonly",
        console: "readonly",
        URL: "readonly",
      },
    },
    rules: recommendedRules,
  },
]);
