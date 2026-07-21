import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["out/**", "release/**", "node_modules/**"],
  },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [eslint.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unsafe-function-type": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-wrapper-object-types": "off",
      "@typescript-eslint/prefer-as-const": "off",
      "no-bitwise": "error",
      "no-caller": "error",
      "no-case-declarations": "off",
      "no-cond-assign": "error",
      "no-empty": "off",
      "no-unsafe-finally": "off",
      "no-useless-escape": "off",
      "prefer-const": "off",
    },
  },
  {
    files: [
      "main/envim/grid.ts",
      "main/envim/highlight.ts",
    ],
    rules: {
      "no-bitwise": "off",
    },
  },
);

