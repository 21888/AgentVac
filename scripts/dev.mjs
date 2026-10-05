import { spawn } from "node:child_process";
import { createServer } from "vite";
import { build } from "esbuild";
import electron from "electron";
await build({
  entryPoints: ["electron/main.ts", "electron/preload.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  outdir: "dist-electron",
  outExtension: { ".js": ".cjs" },
  format: "cjs",
  external: ["electron"],
});
const server = await createServer();
await server.listen();
const child = spawn(electron, ["."], {
  stdio: "inherit",
  env: { ...process.env, AGENTVAC_DEV_URL: "http://127.0.0.1:5173" },
});
child.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
process.on("SIGINT", () => child.kill());
process.on("SIGTERM", () => child.kill());
