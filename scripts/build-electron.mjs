import { build } from "esbuild";
await build({
  entryPoints: {
    main: "electron/main.ts",
    preload: "electron/preload.ts",
    "diagnostic-supervisor": "electron/diagnostic-supervisor.ts",
    "diagnostic-worker": "electron/diagnostic-worker.ts",
    "cursor-sql-worker": "electron/conversations/cursor-sql-worker.ts",
  },
  bundle: true,
  platform: "node",
  target: "node22",
  outdir: "dist-electron",
  outExtension: { ".js": ".cjs" },
  format: "cjs",
  external: ["electron"],
});
