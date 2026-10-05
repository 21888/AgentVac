import { build } from "esbuild";
await build({
  entryPoints: [
    "electron/main.ts",
    "electron/preload.ts",
    "electron/diagnostic-supervisor.ts",
    "electron/diagnostic-worker.ts",
  ],
  bundle: true,
  platform: "node",
  target: "node22",
  outdir: "dist-electron",
  outExtension: { ".js": ".cjs" },
  format: "cjs",
  external: ["electron"],
});
