import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
type Handle = Pick<Awaited<ReturnType<typeof fs.open>>, "truncate" | "close">;
interface FixtureIO {
  platform: NodeJS.Platform;
  open: (file: string, flags: "wx") => Promise<Handle>;
  markSparse: (file: string) => Promise<void>;
}
const actual: FixtureIO = {
  platform: process.platform,
  open: (file, flags) => fs.open(file, flags),
  markSparse: async (file) => {
    // Only a newly created synthetic fixture is passed here. No elevation,
    // system setting changes, broad file selection or fallback allocation.
    await run("fsutil.exe", ["sparse", "setflag", file], {
      timeout: 5000,
      windowsHide: true,
    });
  },
};

/** Test-only fixture; Windows ftruncate alone does not create a sparse file. */
export async function createSparseFixture(
  file: string,
  bytes: number,
  io: FixtureIO = actual,
): Promise<void> {
  if (!Number.isSafeInteger(bytes) || bytes < 0)
    throw new Error("Invalid synthetic fixture length");
  const handle = await io.open(file, "wx");
  try {
    // Mark before extending, so a failed prerequisite cannot allocate 300 GiB.
    if (io.platform === "win32") await io.markSparse(file);
    await handle.truncate(bytes);
  } finally {
    await handle.close();
  }
}
