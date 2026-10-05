import { promises as fs } from "node:fs";
import path from "node:path";
const specs: [string, number, number][] = [
  ["log/codex-tui.log.1", 12_400_000, 48],
  ["log/codex-tui.log.2", 7_200_000, 92],
  ["log/codex-tui.log.2026-05-01.gz", 3_600_000, 140],
  ["log/codex-tui.log", 1_200_000, 80],
  ["log/codex-tui.log.3", 600_000, 3],
  ["sessions/2025/06/rollout-demo-planning.jsonl", 28_000_000, 105],
  ["sessions/2025/08/rollout-demo-debugging.jsonl", 18_500_000, 61],
  ["sessions/2026/10/rollout-current.jsonl", 120_000, 0],
  ["archived_sessions/rollout-archived.jsonl", 6_800_000, 190],
  ["cache/example.cache", 2_800_000, 90],
  ["auth.json", 2400, 200],
  ["config.toml", 4200, 200],
  ["history.jsonl", 880_000, 90],
  ["state_5.sqlite", 3_000_000, 90],
  ["logs_1.sqlite", 15_200_000, 90],
  ["state_5.sqlite-wal", 180_000, 90],
  ["session_index.jsonl", 9800, 90],
  ["skills/my-skill/SKILL.md", 1500, 90],
  ["projects/keep.txt", 1200, 90],
  ["mcp/settings.json", 1200, 90],
  ["unknown-notes.txt", 1200, 90],
];
export const DEMO_FIXTURE_PATHS: readonly string[] = Object.freeze(
  specs.map(([relative]) => relative),
);
export async function createDemo(root: string) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  for (const [rel, size, age] of specs) {
    const p = path.join(root, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    const h = await fs.open(p, "wx");
    try {
      await h.writeFile("AgentVac DEMO FIXTURE — generated test data only.\n");
      await h.truncate(size);
    } finally {
      await h.close();
    }
    const d = new Date(Date.now() - age * 86_400_000 - 1000);
    await fs.utimes(p, d, d);
  }
}
