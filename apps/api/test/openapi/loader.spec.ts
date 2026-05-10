/**
 * loadOpenApiContracts — unit spec (T304-B-api coverage lift).
 *
 * Strategy: all tests inject a custom `dir` via the loader's `LoadOpenApiOptions`
 * seam, pointing at real temp directories populated with fixture YAML/non-YAML
 * files. No fs mocks are needed — the `dir` option is the clean injection point.
 *
 * For the readFileSync-throws branch (B3): a *directory* whose name ends in
 * `.yaml` is created inside the temp dir. `readdirSync` lists it, the `.yaml`
 * filter passes, and `readFileSync` on a directory path throws on all major
 * OSes (EISDIR on Linux/macOS, EPERM/EBADF on Windows). The loader catches
 * any throw from `readFileSync` and wraps it with "cannot read {path}".
 *
 * Note on the `i` flag in `/\.(ya?ml)$/i` (loader.ts:90): it is effectively
 * unreachable because the upstream filter uses case-sensitive `endsWith`, so
 * upper-case extensions (.YML, .YAML) are filtered out before the regex runs.
 * The flag is defensive dead code — not a bug, just cosmetically misleading.
 *
 * Branches covered
 * ────────────────
 * B1  readdirSync throws (non-existent directory)           → "cannot read directory"
 * B2  yamls.length === 0 (dir has no .yaml/.yml files)      → "no YAML files found"
 * B3  readFileSync throws (.yaml entry is a sub-directory)  → "cannot read"
 * B4  parseYaml throws (malformed YAML content)             → "invalid YAML in"
 * B5  document === null  ("null" YAML literal)              → "empty or whitespace-only YAML"
 * B6a document === undefined (empty file)                   → "empty or whitespace-only YAML"
 * B6b document === undefined (whitespace-only file)         → "empty or whitespace-only YAML"
 * B7  happy path — single .yaml file                        → 1 contract, id/path/document
 * B8  happy path — .yml extension recognised                → id strips ".yml"
 * B9  happy path — non-YAML files are ignored               → only .yaml/.yml returned
 * B10 happy path — multiple files returned in sorted order  → alphabetical by filename
 * B11 happy path — mixed .yaml and .yml sorted together     → unified sort
 * B12 happy path — default dir (no opts arg)                → real contracts loaded
 * B13 document field holds full parsed YAML object structure
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

import { loadOpenApiContracts } from "../../src/openapi/loader";

function makeTmpDir(): string {
  return mkdtempSync(join(os.tmpdir(), "openapi-loader-test-"));
}

function cleanTmpDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function writeYaml(dir: string, filename: string, content: string): void {
  writeFileSync(join(dir, filename), content, "utf8");
}

describe("loadOpenApiContracts", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    cleanTmpDir(tmpDir);
  });

  // -------------------------------------------------------------------------
  // Error branches
  // -------------------------------------------------------------------------

  describe("error branches", () => {
    it("B1 — throws when the target directory does not exist", () => {
      const missing = join(tmpDir, "does-not-exist");
      expect(() => loadOpenApiContracts({ dir: missing })).toThrow(
        /cannot read directory/,
      );
    });

    it("B1 — error message includes the missing directory path", () => {
      const missing = join(tmpDir, "absent-dir");
      let msg = "";
      try {
        loadOpenApiContracts({ dir: missing });
      } catch (e) {
        msg = e instanceof Error ? e.message : String(e);
      }
      expect(msg).toContain("absent-dir");
    });

    it("B2 — throws when directory contains no .yaml or .yml files", () => {
      writeFileSync(join(tmpDir, "readme.md"), "# readme", "utf8");
      writeFileSync(join(tmpDir, "config.json"), "{}", "utf8");

      expect(() => loadOpenApiContracts({ dir: tmpDir })).toThrow(
        /no YAML files found/,
      );
    });

    it("B2 — throws when directory is completely empty", () => {
      expect(() => loadOpenApiContracts({ dir: tmpDir })).toThrow(
        /no YAML files found/,
      );
    });

    it("B3 — throws when a .yaml entry is a sub-directory (readFileSync fails)", () => {
      // A directory named "sub.yaml" passes the .yaml filter but causes
      // readFileSync to throw (EISDIR on POSIX, EPERM/EBADF on Windows).
      mkdirSync(join(tmpDir, "sub.yaml"));

      expect(() => loadOpenApiContracts({ dir: tmpDir })).toThrow(
        /cannot read/,
      );
    });

    it("B4 — throws on syntactically malformed YAML", () => {
      writeYaml(tmpDir, "broken.yaml", "key: [unclosed\n  - item");

      expect(() => loadOpenApiContracts({ dir: tmpDir })).toThrow(
        /invalid YAML in/,
      );
    });

    it("B4 — error message for malformed YAML includes the file path", () => {
      writeYaml(tmpDir, "broken.yaml", "key: [unclosed\n  - item");
      let msg = "";
      try {
        loadOpenApiContracts({ dir: tmpDir });
      } catch (e) {
        msg = e instanceof Error ? e.message : String(e);
      }
      expect(msg).toContain("broken.yaml");
    });

    it("B5 — throws when YAML document parses to null (bare 'null' literal)", () => {
      writeYaml(tmpDir, "null-doc.yaml", "null");

      expect(() => loadOpenApiContracts({ dir: tmpDir })).toThrow(
        /empty or whitespace-only YAML/,
      );
    });

    it("B6a — throws when YAML file is empty (document is undefined)", () => {
      writeYaml(tmpDir, "empty.yaml", "");

      expect(() => loadOpenApiContracts({ dir: tmpDir })).toThrow(
        /empty or whitespace-only YAML/,
      );
    });

    it("B6b — throws when YAML file contains only whitespace (document is undefined)", () => {
      writeYaml(tmpDir, "whitespace.yaml", "   \n\n  \t  ");

      expect(() => loadOpenApiContracts({ dir: tmpDir })).toThrow(
        /empty or whitespace-only YAML/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Happy-path branches
  // -------------------------------------------------------------------------

  describe("happy path", () => {
    it("B7 — loads a single .yaml file and returns exactly one contract", () => {
      writeYaml(tmpDir, "test.openapi.yaml", "name: test");

      const contracts = loadOpenApiContracts({ dir: tmpDir });

      expect(contracts).toHaveLength(1);
    });

    it("B7 — contract id strips the .yaml extension from the filename stem", () => {
      writeYaml(tmpDir, "test.openapi.yaml", "name: test");

      const [c] = loadOpenApiContracts({ dir: tmpDir });

      expect(c!.id).toBe("test.openapi");
    });

    it("B7 — contract path is the absolute path to the file on disk", () => {
      writeYaml(tmpDir, "test.openapi.yaml", "name: test");

      const [c] = loadOpenApiContracts({ dir: tmpDir });

      expect(c!.path).toBe(join(tmpDir, "test.openapi.yaml"));
    });

    it("B8 — .yml extension is recognised and stripped from the contract id", () => {
      writeYaml(tmpDir, "service.yml", "name: service");

      const [c] = loadOpenApiContracts({ dir: tmpDir });

      expect(c!.id).toBe("service");
    });

    it("B9 — non-YAML files (.md, .json, .ts) alongside .yaml files are ignored", () => {
      writeYaml(tmpDir, "contract.yaml", "openapi: '3.1.0'");
      writeFileSync(join(tmpDir, "README.md"), "docs", "utf8");
      writeFileSync(join(tmpDir, "config.json"), "{}", "utf8");
      writeFileSync(join(tmpDir, "types.ts"), "// ts", "utf8");

      const contracts = loadOpenApiContracts({ dir: tmpDir });

      expect(contracts).toHaveLength(1);
      expect(contracts[0]!.id).toBe("contract");
    });

    it("B10 — multiple .yaml files are returned in ascending alphabetical order", () => {
      writeYaml(tmpDir, "zeta.yaml", "name: zeta");
      writeYaml(tmpDir, "alpha.yaml", "name: alpha");
      writeYaml(tmpDir, "beta.yaml", "name: beta");

      const contracts = loadOpenApiContracts({ dir: tmpDir });

      expect(contracts.map((c) => c.id)).toEqual(["alpha", "beta", "zeta"]);
    });

    it("B11 — mixed .yaml and .yml files are sorted together by filename", () => {
      writeYaml(tmpDir, "b-service.yml", "name: b");
      writeYaml(tmpDir, "a-service.yaml", "name: a");

      const contracts = loadOpenApiContracts({ dir: tmpDir });

      expect(contracts.map((c) => c.id)).toEqual(["a-service", "b-service"]);
    });

    it("B12 — default dir (no opts) loads real contracts from packages/contracts/openapi/", () => {
      const contracts = loadOpenApiContracts();

      expect(contracts.length).toBeGreaterThan(0);
    });

    it("B12 — real contracts all have ids matching the *.openapi naming convention", () => {
      const contracts = loadOpenApiContracts();

      for (const c of contracts) {
        expect(c.id).toMatch(/\.openapi$/);
      }
    });

    it("B12 — real contracts paths reference the packages/contracts/openapi/ directory", () => {
      const contracts = loadOpenApiContracts();

      for (const c of contracts) {
        expect(c.path).toMatch(/packages[\\/]contracts[\\/]openapi/);
      }
    });

    it("B12 — real contracts have non-null, non-undefined document fields", () => {
      const contracts = loadOpenApiContracts();

      for (const c of contracts) {
        expect(c.document).toBeDefined();
        expect(c.document).not.toBeNull();
      }
    });

    it("B13 — document holds the full parsed YAML object tree", () => {
      const yaml = [
        "openapi: '3.1.0'",
        "info:",
        "  title: My API",
        "  version: '2.0'",
        "paths: {}",
      ].join("\n");
      writeYaml(tmpDir, "api.yaml", yaml);

      const [c] = loadOpenApiContracts({ dir: tmpDir });

      expect(c!.document).toMatchObject({
        openapi: "3.1.0",
        info: { title: "My API", version: "2.0" },
        paths: {},
      });
    });
  });
});
