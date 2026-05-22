/**
 * Unit tests for migration-dir discovery (T483 / P4 W3 follow-up).
 *
 * The registrar in `apps/api/src/app.module.ts` previously called
 * `require.resolve("@data-pulse-2/db/package.json")` which is rejected
 * by the package's restricted `exports` map (PR #245). That fail-safe
 * pinned `db_migration_status{state="applied"}=0, state="pending"=1`
 * indefinitely, making the metric useless for alerts.
 *
 * The replacement discovery functions are:
 *   - `findWorkspaceRoot(startDir)` — walks upward looking for
 *     `pnpm-workspace.yaml`.
 *   - `resolveMigrationsDir(startDir, env)` — honours `DB_MIGRATIONS_DIR`
 *     override; otherwise falls back to `<workspace>/packages/db/drizzle/`.
 *   - `countMigrationFiles(startDir, env)` — counts `*.sql` (excluding
 *     `*.down.sql`) in the resolved dir, throws on FS errors.
 *
 * These tests cover the discovery behaviour. The registrar / callback
 * contract is covered by `db-migration-status-gauge.spec.ts`.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  countMigrationFiles,
  findWorkspaceRoot,
  resolveMigrationsDir,
} from "../../src/app.module";

// ---------------------------------------------------------------------------
// Test fixture: build a fake workspace tree under os.tmpdir().
// ---------------------------------------------------------------------------

async function makeFakeWorkspace(opts: {
  withSentinel?: boolean;
  files?: readonly string[];
}): Promise<{
  root: string;
  drizzleDir: string;
  deepStart: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "dp2-mig-disc-"));
  const drizzleDir = join(root, "packages", "db", "drizzle");
  const deepStart = join(root, "apps", "api", "src");
  await writeFile(join(root, ".keep"), "");
  // Materialise nested dirs by writing a sentinel file at the deepest point.
  await import("node:fs/promises").then(async (fs) => {
    await fs.mkdir(drizzleDir, { recursive: true });
    await fs.mkdir(deepStart, { recursive: true });
  });
  if (opts.withSentinel !== false) {
    await writeFile(
      join(root, "pnpm-workspace.yaml"),
      "packages:\n  - 'packages/*'\n",
    );
  }
  for (const f of opts.files ?? []) {
    await writeFile(join(drizzleDir, f), "-- noop\n");
  }
  return {
    root,
    drizzleDir,
    deepStart,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// findWorkspaceRoot
// ---------------------------------------------------------------------------

describe("findWorkspaceRoot", () => {
  it("returns the directory containing pnpm-workspace.yaml when walking up", async () => {
    const fx = await makeFakeWorkspace({ withSentinel: true });
    try {
      const found = await findWorkspaceRoot(fx.deepStart);
      expect(found).not.toBeNull();
      // realpath-normalise both sides — tmpdir on macOS returns /var/... but
      // resolves to /private/var/... and similar quirks exist on Windows.
      const fs = await import("node:fs/promises");
      const expected = await fs.realpath(fx.root);
      const actual = await fs.realpath(found as string);
      expect(actual).toBe(expected);
    } finally {
      await fx.cleanup();
    }
  });

  it("returns null when no ancestor contains pnpm-workspace.yaml", async () => {
    const fx = await makeFakeWorkspace({ withSentinel: false });
    try {
      // Start from a path with no sentinel — walks all the way to FS root.
      const found = await findWorkspaceRoot(fx.deepStart);
      // It may either hit FS root and return null, OR — if the developer
      // running the test happens to have a pnpm-workspace.yaml at some
      // ancestor of os.tmpdir() (extremely rare) — return that. We only
      // assert that if it returns non-null, it is not OUR fake root.
      if (found !== null) {
        expect(found).not.toBe(fx.root);
      }
    } finally {
      await fx.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// resolveMigrationsDir
// ---------------------------------------------------------------------------

describe("resolveMigrationsDir", () => {
  it("honours DB_MIGRATIONS_DIR env override", async () => {
    const fx = await makeFakeWorkspace({ withSentinel: true });
    try {
      const out = await resolveMigrationsDir(fx.deepStart, {
        DB_MIGRATIONS_DIR: "/some/other/place",
      });
      expect(out).toBe(resolve("/some/other/place"));
    } finally {
      await fx.cleanup();
    }
  });

  it("ignores empty DB_MIGRATIONS_DIR (treats as unset)", async () => {
    const fx = await makeFakeWorkspace({ withSentinel: true });
    try {
      const out = await resolveMigrationsDir(fx.deepStart, {
        DB_MIGRATIONS_DIR: "",
      });
      expect(out).not.toBeNull();
      const fs = await import("node:fs/promises");
      const expected = await fs.realpath(fx.drizzleDir);
      const actual = await fs.realpath(out as string);
      expect(actual).toBe(expected);
    } finally {
      await fx.cleanup();
    }
  });

  it("falls back to <workspace>/packages/db/drizzle/ via upward walk", async () => {
    const fx = await makeFakeWorkspace({ withSentinel: true });
    try {
      const out = await resolveMigrationsDir(fx.deepStart, {});
      expect(out).not.toBeNull();
      const fs = await import("node:fs/promises");
      const expected = await fs.realpath(fx.drizzleDir);
      const actual = await fs.realpath(out as string);
      expect(actual).toBe(expected);
    } finally {
      await fx.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// countMigrationFiles
// ---------------------------------------------------------------------------

describe("countMigrationFiles", () => {
  it("counts *.sql migrations and excludes *.down.sql rollback companions", async () => {
    const fx = await makeFakeWorkspace({
      withSentinel: true,
      files: [
        "0000_initial.sql",
        "0000_initial.down.sql",
        "0001_pos.sql",
        "0001_pos.down.sql",
        "0002_shifts.sql",
        "0002_shifts.down.sql",
      ],
    });
    try {
      const n = await countMigrationFiles(fx.deepStart, {});
      expect(n).toBe(3);
    } finally {
      await fx.cleanup();
    }
  });

  it("only counts files matching ^\\d{4}_.+\\.sql$ (ignores README, junk)", async () => {
    const fx = await makeFakeWorkspace({
      withSentinel: true,
      files: [
        "0000_initial.sql",
        "0001_pos.sql",
        "README.md",
        "meta-snapshot.json",
        "notes.txt",
        "abc_initial.sql", // wrong prefix shape
        "00_short.sql", // too few digits
      ],
    });
    try {
      const n = await countMigrationFiles(fx.deepStart, {});
      expect(n).toBe(2);
    } finally {
      await fx.cleanup();
    }
  });

  it("returns a stable count on repeated invocations", async () => {
    const fx = await makeFakeWorkspace({
      withSentinel: true,
      files: ["0000_initial.sql", "0001_pos.sql", "0001_pos.down.sql"],
    });
    try {
      const a = await countMigrationFiles(fx.deepStart, {});
      const b = await countMigrationFiles(fx.deepStart, {});
      expect(a).toBe(2);
      expect(b).toBe(2);
    } finally {
      await fx.cleanup();
    }
  });

  it("throws when DB_MIGRATIONS_DIR points at a non-existent directory", async () => {
    await expect(
      countMigrationFiles(__dirname, {
        DB_MIGRATIONS_DIR: "/definitely/not/a/real/path/for-tests",
      }),
    ).rejects.toThrow();
  });

  it("throws when the workspace root cannot be found and no override is set", async () => {
    // Use a temp dir with NO sentinel anywhere we control. We can't fully
    // guarantee no ancestor has pnpm-workspace.yaml in CI sandboxes, but
    // we point at a path that has no `packages/db/drizzle/` either, so
    // readdir will fail even if the upward walk somehow finds a sentinel.
    const fx = await makeFakeWorkspace({ withSentinel: false });
    try {
      await expect(countMigrationFiles(fx.deepStart, {})).rejects.toThrow();
    } finally {
      await fx.cleanup();
    }
  });

  it("matches the live repo's up-migration count when called with default args", async () => {
    // Smoke test: with default startDir (= apps/api/src or apps/api/dist),
    // discovery must find the real packages/db/drizzle and return a positive
    // count equal to the actual up-migration files on disk.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    // From this test file's dir, walk up to find pnpm-workspace.yaml.
    let root = __dirname;
    for (let i = 0; i < 32; i += 1) {
      try {
        const s = await fs.stat(path.join(root, "pnpm-workspace.yaml"));
        if (s.isFile()) break;
      } catch {
        // continue
      }
      const parent = path.dirname(root);
      if (parent === root) throw new Error("repo root not found");
      root = parent;
    }
    const drizzleDir = path.join(root, "packages", "db", "drizzle");
    const files = await fs.readdir(drizzleDir);
    const expected = files.filter(
      (f) => /^\d{4}_.+\.sql$/.test(f) && !f.endsWith(".down.sql"),
    ).length;
    expect(expected).toBeGreaterThan(0);

    const actual = await countMigrationFiles(); // default args
    expect(actual).toBe(expected);
  });
});
