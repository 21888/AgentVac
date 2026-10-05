import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assertPlainDirectoryPath } from "./engine.js";
import type { Preferences, ThemeMode } from "../shared/types.js";
const isTheme = (value: unknown): value is ThemeMode =>
  value === "system" || value === "light" || value === "dark";
export class PreferenceStore {
  private value: Preferences = { theme: "system" };
  private writes: Promise<void> = Promise.resolve();
  constructor(private directory: string) {}
  current(): Preferences {
    return { ...this.value };
  }
  async flush(): Promise<void> {
    await this.writes;
  }
  async load(): Promise<Preferences> {
    await assertPlainDirectoryPath(this.directory);
    const file = path.join(this.directory, "preferences.json");
    try {
      const s = await fs.lstat(file);
      if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > 4096)
        return this.current();
      const h = await fs.open(
        file,
        constants.O_RDONLY |
          (constants.O_NOFOLLOW ?? 0) |
          (constants.O_NONBLOCK ?? 0),
      );
      try {
        const st = await h.stat();
        if (!st.isFile() || st.nlink !== 1 || st.size > 4096)
          return this.current();
        const parsed = JSON.parse(await h.readFile("utf8"));
        if (isTheme(parsed?.theme)) this.value = { theme: parsed.theme };
      } finally {
        await h.close();
      }
    } catch (e) {
      if (
        !(e instanceof SyntaxError) &&
        !["ENOENT", "EACCES", "EPERM"].includes(
          (e as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw e;
    }
    return this.current();
  }
  async setTheme(theme: ThemeMode): Promise<Preferences> {
    if (!isTheme(theme))
      throw new Error("无效主题，仅支持浅色、深色或跟随系统。");
    const task = this.writes.then(async () => {
      await assertPlainDirectoryPath(this.directory);
      const file = path.join(this.directory, "preferences.json");
      try {
        const s = await fs.lstat(file);
        if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1)
          throw new Error("主题设置文件异常，未修改。");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      const temp = path.join(
        this.directory,
        ".preferences-" + randomUUID() + ".tmp",
      );
      const h = await fs.open(temp, "wx", 0o600);
      try {
        try {
          await h.writeFile(JSON.stringify({ theme }, null, 2));
          await h.sync();
        } finally {
          await h.close();
        }
        await assertPlainDirectoryPath(this.directory);
        await fs.rename(temp, file);
        this.value = { theme };
        return this.current();
      } finally {
        await fs.unlink(temp).catch(() => {});
      }
    });
    this.writes = task.then(
      () => {},
      () => {},
    );
    return task;
  }
}
