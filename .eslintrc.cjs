/* eslint-env node */
/**
 * Root ESLint config for the Data-Pulse-2 monorepo.
 * Workspace packages may extend or override this file via their own .eslintrc.
 *
 * Custom rule slot: the "no-unscoped-tenant-query" rule (see tasks.md T208)
 * will be wired here once the rule package exists. Until then, this is a
 * placeholder configuration only.
 */
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    project: false
  },
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended"
  ],
  env: {
    node: true,
    es2022: true
  },
  rules: {
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-unused-vars": [
      "error",
      { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" }
    ],
    "no-console": ["warn", { "allow": ["warn", "error"] }],
    "eqeqeq": ["error", "always"],
    "no-implicit-coercion": "error"
  },
  ignorePatterns: [
    "node_modules",
    "dist",
    "build",
    "coverage",
    "**/*.d.ts",
    ".turbo",
    ".cache"
  ]
};
