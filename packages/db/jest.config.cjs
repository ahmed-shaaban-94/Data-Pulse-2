/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  testMatch: ["**/__tests__/**/*.spec.ts"],
  testPathIgnorePatterns: ["/node_modules/", "/__tests__/_helpers/"],
  moduleFileExtensions: ["ts", "js", "json"],
  clearMocks: true,
  restoreMocks: true,
  // Testcontainers needs ample time: image pull (cold) + container boot +
  // multi-step UP/DOWN/UP cycles. Per-test timeout, not per-suite.
  testTimeout: 180000,
  verbose: false,
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/**/*.spec.ts",
    "!src/**/*.d.ts",
    "!src/index.ts",
  ],
};
