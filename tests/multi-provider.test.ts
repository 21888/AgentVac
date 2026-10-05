import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes, createHmac } from "node:crypto";
import { AgentVacEngine } from "../electron/engine.js";
import { AppDataServices } from "../electron/app-services.js";
import { getAdapter } from "../electron/providers/index.js";
import type { ProviderId, ProcessStatus } from "../shared/types.js";
const clear = async (): Promise<ProcessStatus> => ({
  status: "clear",
  details: "synthetic fixture",
});
const options = { minAgeDays: 30, includeSessions: false };
async function fixture(t: TestContext) {
  const base = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "agentvac-multi-"),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const roots = {
    codex: path.join(base, "codex-data"),
    "claude-code": path.join(base, "claude-data"),
    cline: path.join(base, "cline-data"),
    cursor: path.join(base, "Cursor"),
  };
  async function write(
    provider: ProviderId,
    relative: string,
    age = 90,
    value = "synthetic bytes",
  ) {
    const file = path.join(roots[provider], relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value);
    const date = new Date(Date.now() - age * 86400000);
    await fs.utimes(file, date, date);
    return file;
  }
  await write("codex", "log/codex-tui.log.1");
  await fs.mkdir(path.join(roots["claude-code"], "projects"), {
    recursive: true,
  });
  await write("claude-code", "settings.json");
  await write("claude-code", "debug/11111111-1111-4111-8111-111111111111.txt");
  await write(
    "claude-code",
    "debug/22222222-2222-4222-8222-222222222222.txt",
    2,
  );
  await write("cline", "db/sessions.db");
  await write("cline", "globalState.json");
  for (const [id, age] of [
    ["1600000000000_abcde", 90],
    ["1700000000000_fghij", 2],
  ] as const)
    for (const name of [id + ".json", id + ".messages.json", "hooks.jsonl"])
      await write("cline", `sessions/${id}/${name}`, age);
  await fs.mkdir(path.join(roots.cursor, "User/globalStorage"), {
    recursive: true,
  });
  await write("cursor", "logs/20200101T010101/main.log");
  await write("cursor", "logs/20210101T010101/main.log", 2);
  const profile = path.join(base, "profile");
  const service = new AppDataServices(profile, {
    home: path.join(base, "home"),
    env: {},
    processCheck: clear,
    providerProcessCheck: clear,
  });
  await service.initialize();
  return { base, roots, write, profile, service };
}
test("all four providers bind scan, preview, signed history and restart restore", async (t) => {
  const { roots, profile, service } = await fixture(t);
  for (const provider of Object.keys(roots) as ProviderId[]) {
    await service.setProvider(provider);
    await service.selectProviderRoot(roots[provider]);
    const engine = service.engine();
    const scan = await engine.scan(options);
    assert.equal(scan.provider, provider);
    const entry = scan.entries.find((e) => e.selectable);
    assert.ok(entry, provider);
    const original = await fs.readFile(path.join(roots[provider], entry.path));
    const preview = await engine.preview([entry.id]);
    assert.equal(preview.provider, provider);
    assert.equal(preview.root, roots[provider]);
    const moved = await engine.quarantine(preview.token, true);
    assert.equal(moved.completed, 1);
    const restarted = new AppDataServices(profile, {
      home: roots[provider],
      env: {},
      processCheck: clear,
      providerProcessCheck: clear,
    });
    await restarted.initialize();
    assert.equal(restarted.getContext().provider, provider);
    assert.equal((await restarted.engine().history())[0].provider, provider);
    assert.equal(
      (await restarted.engine().restore(moved.batchId, true)).completed,
      1,
    );
    assert.deepEqual(
      await fs.readFile(path.join(roots[provider], entry.path)),
      original,
    );
  }
});
test("switching provider drops root, scan IDs, outstanding tokens and old engine access", async (t) => {
  const { roots, service } = await fixture(t);
  await service.selectCodexRoot(roots.codex);
  const old = service.engine();
  const scan = await old.scan(options);
  const preview = await old.preview([
    scan.entries.find((e) => e.selectable)!.id,
  ]);
  await service.setProvider("claude-code");
  assert.equal(service.getContext().root, null);
  assert.equal(service.getContext().provider, "claude-code");
  await assert.rejects(old.quarantine(preview.token, true));
  await assert.rejects(old.history(), /切换/);
  await service.selectProviderRoot(roots["claude-code"]);
  await assert.rejects(
    service.engine().quarantine(preview.token, true),
    /失效/,
  );
  await assert.rejects(
    service.engine().preview([scan.entries[0].id]),
    /失效|不可隔离/,
  );
});
test("wrong-provider roots fail without replacing prior valid selection", async (t) => {
  const { roots, service } = await fixture(t);
  await service.selectCodexRoot(roots.codex);
  for (const [provider, root] of [
    ["claude-code", roots.codex],
    ["cline", roots.cursor],
    ["cursor", roots.cline],
    ["codex", roots.cline],
  ] as const) {
    await assert.rejects(service.selectProviderRoot(root, provider));
    assert.equal(service.getContext().root, roots.codex);
  }
});
test("candidate activation is provider-bound and diagnostics reject foreign workspaces", async (t) => {
  const { roots, service } = await fixture(t);
  const id = (await service.getAppData()).candidates.find(
    (c) => c.kind === "codex-home",
  )!.id;
  await service.setProvider("claude-code");
  await assert.rejects(service.activateCandidate(id), /其他提供方/);
  await service.selectProviderRoot(roots["claude-code"]);
  const record = (await service.getAppData()).workspaces.entries[0];
  await assert.rejects(
    service.diagnose({ workspaceIds: [record.id], configOptIn: false }),
    /仅支持 Codex/,
  );
});
test("legacy signed v1 Codex manifests remain recoverable and reject foreign attribution", async (t) => {
  const { roots } = await fixture(t);
  const key = randomBytes(32);
  const engine = new AgentVacEngine(roots.codex, key, false, clear);
  const scan = await engine.scan(options);
  const preview = await engine.preview([
    scan.entries.find((e) => e.selectable)!.id,
  ]);
  const moved = await engine.quarantine(preview.token, true);
  const manifest = path.join(
    roots.codex,
    ".agentvac-quarantine",
    moved.batchId,
    "manifest.json",
  );
  const saved = JSON.parse(await fs.readFile(manifest, "utf8"));
  saved.journal.version = 1;
  delete saved.journal.provider;
  saved.signature = createHmac("sha256", key)
    .update(JSON.stringify(saved.journal))
    .digest("hex");
  await fs.writeFile(manifest, JSON.stringify(saved));
  const legacy = new AgentVacEngine(roots.codex, key, false, clear);
  assert.equal((await legacy.history())[0].provider, "codex");
  assert.equal((await legacy.restore(moved.batchId, true)).completed, 1);
});
test("duplicate quarantine and restore requests never duplicate moved bytes", async (t) => {
  const { roots, service } = await fixture(t);
  await service.selectProviderRoot(roots.cursor, "cursor");
  const engine = service.engine();
  const scan = await engine.scan(options);
  const preview = await engine.preview([
    scan.entries.find((e) => e.selectable)!.id,
  ]);
  const results = await Promise.allSettled([
    engine.quarantine(preview.token, true),
    engine.quarantine(preview.token, true),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const moved = (
    results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>
  ).value;
  assert.equal((await engine.restore(moved.batchId, true)).completed, 1);
  assert.equal((await engine.restore(moved.batchId, true)).completed, 0);
});
test("cancelling a provider scan invalidates selections without changing any file", async (t) => {
  const { roots, service } = await fixture(t);
  await service.selectProviderRoot(roots["claude-code"], "claude-code");
  const engine = service.engine();
  let cancelled = false;
  await assert.rejects(
    engine.scan(options, (progress) => {
      if (progress.phase === "scanning" && !cancelled) {
        cancelled = true;
        engine.cancelScan(progress.requestId);
      }
    }),
    /取消/,
  );
  const result = await engine.scan(options);
  assert.equal(result.status, "complete");
  assert.ok(result.entries.some((e) => e.selectable));
});
test("provider identifiers cannot inject paths or borrow another provider", async (t) => {
  const { service, roots } = await fixture(t);
  await service.selectCodexRoot(roots.codex);
  for (const id of ["../cursor", "Cursor", "", null, {}, "sqlite"]) {
    await assert.rejects(service.setProvider(id as ProviderId), /无效/);
    assert.equal(service.getContext().provider, "codex");
  }
});
test("provider switch during admitted scan is refused until cancellation settles", async (t) => {
  const { service, roots } = await fixture(t);
  await service.selectCodexRoot(roots.codex);
  const engine = service.engine();
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => (resume = resolve));
  const original = fs.opendir;
  let held = false;
  fs.opendir = (async (...args: Parameters<typeof fs.opendir>) => {
    if (!held && String(args[0]) === roots.codex) {
      held = true;
      await gate;
    }
    return (original as any)(...args);
  }) as typeof fs.opendir;
  try {
    const scan = engine.scan(options);
    while (!held) await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(service.setProvider("cursor"), /正在进行/);
    assert.equal(service.getContext().provider, "codex");
    engine.cancelScan();
    resume();
    await assert.rejects(scan, /取消/);
    await service.setProvider("cursor");
    assert.equal(service.getContext().root, null);
  } finally {
    resume();
    fs.opendir = original;
  }
});
test("provider switch during quarantine cannot redirect an admitted move", async (t) => {
  const { service, roots } = await fixture(t);
  await service.selectCodexRoot(roots.codex);
  const engine = service.engine();
  const scan = await engine.scan(options);
  const preview = await engine.preview([
    scan.entries.find((e) => e.selectable)!.id,
  ]);
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => (resume = resolve));
  const original = fs.rename;
  let held = false;
  fs.rename = (async (from: any, to: any) => {
    if (!held && String(from).endsWith("codex-tui.log.1")) {
      held = true;
      await gate;
    }
    return original(from, to);
  }) as typeof fs.rename;
  try {
    const move = engine.quarantine(preview.token, true);
    while (!held) await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(service.setProvider("cursor"), /正在进行/);
    assert.equal(service.getContext().provider, "codex");
    resume();
    const result = await move;
    assert.equal(result.completed, 1);
    assert.equal((await engine.restore(result.batchId, true)).completed, 1);
  } finally {
    resume();
    fs.rename = original;
  }
});
test("Codex demo keeps its own provider when launched from another provider", async (t) => {
  const { service } = await fixture(t);
  await service.setProvider("cursor");
  const context = await service.loadDemo();
  assert.equal(context.provider, "codex");
  assert.equal(context.demo, true);
  const old = service.engine();
  await service.setProvider("cline");
  assert.equal(service.getContext().demo, false);
  assert.equal(service.getContext().root, null);
  await assert.rejects(old.history(), /切换/);
});
