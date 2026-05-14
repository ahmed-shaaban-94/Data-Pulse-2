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
    // CLI entry points are exercised via child-process spawn in migrate.spec.ts;
    // Istanbul does not instrument spawned child processes, so coverage reads 0%
    // regardless of test completeness. Exclude to avoid misleading the denominator.
    "!src/cli/**",
    // Drizzle schema declarations contain FK lazy-reference callbacks such as
    // `() => tenants.id` that are part of Drizzle's internal builder API, not
    // application logic. Excluding prevents ~78 uncallable functions from
    // inflating the function denominator.
    "!src/schema/**",
  ],
  coverageThreshold: {
    global: {
      statements: 80,
      branches: 80,
      functions: 80,
      lines: 80,
    },
  },
};
