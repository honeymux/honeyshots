import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import perfectionist from "eslint-plugin-perfectionist";
import { Alphabet } from "eslint-plugin-perfectionist/alphabet";
import tseslint from "typescript-eslint";

const alphabet = Alphabet.generateRecommendedAlphabet()
  .sortByLocaleCompare("en-US")
  .placeAllWithCaseBeforeAllWithOtherCase("uppercase")
  .getCharacters();

export default tseslint.config(
  {
    ignores: ["node_modules/", "dist/"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ...perfectionist.configs["recommended-alphabetical"],
    rules: Object.fromEntries(
      Object.entries(
        perfectionist.configs["recommended-alphabetical"].rules,
      ).map(([rule, [severity]]) => [rule, [severity, { order: "asc" }]]),
    ),
    settings: {
      perfectionist: {
        alphabet,
        ignoreCase: false,
        type: "custom",
      },
    },
  },
  prettier,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
);
