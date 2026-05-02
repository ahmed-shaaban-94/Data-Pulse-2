/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  testMatch: ["**/__tests__/**/*.spec.ts"],
  moduleFileExtensions: ["ts", "js", "json"],
  clearMocks: true,
  restoreMocks: true,
  verbose: false,
};
