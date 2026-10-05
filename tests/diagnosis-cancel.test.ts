import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { AppDataServices } from "../electron/app-services.js";
async function setup(t: any) {
  const base = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "agentvac-diagnosis-cancel-"),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "selected");
  await fs.mkdir(root);
  const services = new AppDataServices(path.join(base, "profile"), {
    home: path.join(base, "unused-home"),
    env: {},
    cwd: base,
  });
  await services.initialize();
  await services.selectCodexRoot(root);
  const id = (await services.getAppData()).workspaces.entries[0].id;
  return { base, root, id, services };
}
test("diagnosis cancellation is bound to request identity and cancels before source traversal", async (t) => {
  const { services, id } = await setup(t);
  const requestId = randomUUID();
  const pending = services.diagnose({
    requestId,
    workspaceIds: [id],
    configOptIn: false,
  });
  services.cancelDiagnosis(requestId);
  await assert.rejects(() => pending, /诊断已取消/);
  const next = await services.diagnose({
    requestId: randomUUID(),
    workspaceIds: [id],
    configOptIn: false,
  });
  assert.equal(next.observational, true);
});
test("late cancel does not cancel a later diagnostic, and flush waits for cancellation settlement", async (t) => {
  const { services, id, root } = await setup(t);
  const old = randomUUID();
  await services.diagnose({
    requestId: old,
    workspaceIds: [id],
    configOptIn: false,
  });
  const current = randomUUID();
  const original = fs.opendir;
  let reached!: () => void;
  const gateReached = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  fs.opendir = (async (p: any, ...args: any[]) => {
    if (!held && String(p) === root) {
      held = true;
      reached();
      await gate;
    }
    return (original as any)(p, ...args);
  }) as any;
  try {
    const pending = services.diagnose({
      requestId: current,
      workspaceIds: [id],
      configOptIn: false,
    });
    await gateReached;
    services.cancelDiagnosis(old);
    services.cancelDiagnosis(current);
    let flushed = false;
    const flushing = services.flush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    assert.equal(flushed, false);
    release();
    await assert.rejects(() => pending, /诊断已取消/);
    await flushing;
    assert.equal(flushed, true);
  } finally {
    release?.();
    fs.opendir = original;
  }
  const next = services.diagnose({
    requestId: randomUUID(),
    workspaceIds: [id],
    configOptIn: false,
  });
  services.cancelDiagnosis(old);
  assert.equal((await next).deepCheck.status, "disabled");
});
test("invalid or duplicate active request IDs are rejected without replacing the original controller", async (t) => {
  const { services, id } = await setup(t);
  await assert.rejects(
    () =>
      services.diagnose({
        requestId: "bad",
        workspaceIds: [id],
        configOptIn: false,
      }),
    /标识/,
  );
  const requestId = randomUUID();
  const first = services.diagnose({
    requestId,
    workspaceIds: [id],
    configOptIn: false,
  });
  const second = services.diagnose({
    requestId,
    workspaceIds: [id],
    configOptIn: false,
  });
  await assert.rejects(() => second, /重复/);
  services.cancelDiagnosis();
  await assert.rejects(() => first, /取消/);
});
