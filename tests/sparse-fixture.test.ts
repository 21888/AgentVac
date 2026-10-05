import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSparseFixture } from "./helpers/sparse-fixture.js";

test("Windows fixture marks only the new file sparse before extension", async () => {
  const events: unknown[] = [];
  await createSparseFixture(
    "C:\\generated fixture\\large.bin",
    300 * 1024 ** 3,
    {
      platform: "win32",
      open: async (file, flags) => {
        events.push(["open", file, flags]);
        return {
          truncate: async (bytes) => {
            events.push(["truncate", bytes]);
          },
          close: async () => {
            events.push(["close"]);
          },
        };
      },
      markSparse: async (file) => {
        events.push(["sparse", file]);
      },
    },
  );
  assert.deepEqual(events, [
    ["open", "C:\\generated fixture\\large.bin", "wx"],
    ["sparse", "C:\\generated fixture\\large.bin"],
    ["truncate", 300 * 1024 ** 3],
    ["close"],
  ]);
});

test("failed Windows sparse marking closes the handle without allocating", async () => {
  const events: string[] = [];
  await assert.rejects(
    createSparseFixture("generated.bin", 300 * 1024 ** 3, {
      platform: "win32",
      open: async () => ({
        truncate: async () => {
          events.push("truncate");
        },
        close: async () => {
          events.push("close");
        },
      }),
      markSparse: async () => {
        throw new Error("fixture prerequisite unavailable");
      },
    }),
    /fixture prerequisite unavailable/,
  );
  assert.deepEqual(events, ["close"]);
});

test("POSIX fixture needs no Windows command and closes after truncate failure", async () => {
  const events: string[] = [];
  await assert.rejects(
    createSparseFixture("generated.bin", 42, {
      platform: "darwin",
      open: async () => ({
        truncate: async () => {
          throw new Error("fixture truncate failure");
        },
        close: async () => {
          events.push("close");
        },
      }),
      markSparse: async () => {
        events.push("unexpected Windows command");
      },
    }),
    /fixture truncate failure/,
  );
  assert.deepEqual(events, ["close"]);
});

test("sparse helper creates a real bounded fixture and refuses overwrite", async (t) => {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "agentvac-sparse-fixture-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "generated.bin");
  await createSparseFixture(file, 8 * 1024 ** 2);
  assert.equal((await fs.stat(file)).size, 8 * 1024 ** 2);
  await assert.rejects(createSparseFixture(file, 1), { code: "EEXIST" });
  assert.equal((await fs.stat(file)).size, 8 * 1024 ** 2);
});

test("invalid lengths cannot create files", async () => {
  for (const bytes of [-1, NaN, Infinity, 1.5])
    await assert.rejects(
      createSparseFixture("must-not-exist", bytes),
      /Invalid/,
    );
});
