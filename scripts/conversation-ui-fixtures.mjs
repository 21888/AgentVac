// Synthetic native-format conversation sources. No real account or user content.
import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
export async function createConversationFixtures(base) {
  const roots = Object.fromEntries(
    ["codex", "claude-code", "cline", "cursor"].map((provider) => [
      provider,
      path.join(base, provider === "cursor" ? "Cursor" : provider + "-source"),
    ]),
  );
  const originalFiles = [];
  const write = async (provider, relative, value) => {
    const p = path.join(roots[provider], relative);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, value);
    await fs.utimes(p, new Date("2026-01-01"), new Date("2026-01-01"));
    originalFiles.push(p);
    return p;
  };
  const jsonl = (records) =>
    records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  await write("codex", "config.toml", "# synthetic marker\n");
  await write("claude-code", "settings.json", "{}");
  await write("cline", "globalState.json", "{}");
  await write("cline", "db/sessions.db", "synthetic marker only");
  const created = "2026-08-01T10:00:00.000Z";
  const updated = "2026-08-01T10:39:00.000Z";
  for (let n = 0; n < 25; n++) {
    const sid = `550e8400-e29b-41d4-a716-${String(n).padStart(12, "0")}`;
    const title = `本地对话合成验证 ${String(n).padStart(2, "0")}`;
    const records = [
      {
        type: "session_meta",
        timestamp: created,
        payload: {
          id: sid,
          timestamp: created,
          cwd: "/synthetic/agentvac",
          source: "cli",
          cli_version: "0.1.0",
        },
      },
    ];
    const claude = [];
    for (let m = 0; m < (n === 0 ? 40 : 2); m++) {
      const text =
        m === 0
          ? title
          : m === 39
            ? "最后一条可达 FINAL_NATIVE_TEXT"
            : m === 1
              ? "中间正文 独特关键词 native-search-hit\n<script>window.injection=true</script>"
              : "合成消息 " + m;
      const timestamp = new Date(Date.parse(created) + m * 60000).toISOString();
      const role = m % 2 ? "assistant" : "user";
      records.push({
        type: "response_item",
        timestamp,
        payload: {
          type: "message",
          role,
          content: [
            { type: role === "user" ? "input_text" : "output_text", text },
          ],
        },
      });
      claude.push({
        type: role,
        uuid: `message-${n}-${m}`,
        parentUuid: m ? `message-${n}-${m - 1}` : null,
        sessionId: sid,
        cwd: "/synthetic/agentvac",
        timestamp,
        message: { role, content: text },
      });
    }
    await write(
      "codex",
      `sessions/2026/08/01/rollout-2026-08-01T10-00-00-${sid}.jsonl`,
      jsonl(records),
    );
    await write(
      "claude-code",
      `projects/-synthetic-agentvac/${sid}.jsonl`,
      jsonl(claude),
    );
  }
  const clineId = "1740000000000_abc12";
  const cdir = `sessions/${clineId}`;
  await write(
    "cline",
    `${cdir}/${clineId}.json`,
    JSON.stringify({
      version: 1,
      session_id: clineId,
      source: "cli",
      pid: 0,
      started_at: created,
      ended_at: updated,
      status: "completed",
      interactive: false,
      provider: "synthetic",
      model: "fixture",
      cwd: "/synthetic",
      workspace_root: "/synthetic/agentvac",
      enable_tools: true,
      enable_spawn: false,
      enable_teams: false,
      metadata: { title: "本地对话合成验证 00" },
    }),
  );
  await write(
    "cline",
    `${cdir}/${clineId}.messages.json`,
    JSON.stringify({
      version: 1,
      updated_at: updated,
      agent: "lead",
      sessionId: clineId,
      messages: Array.from({ length: 40 }, (_, n) => ({
        id: "cline-message-" + n,
        role: n % 2 ? "assistant" : "user",
        ts: Date.parse(created) + n * 60000,
        content: [
          {
            type: "text",
            text:
              n === 0
                ? "本地对话合成验证 00"
                : n === 39
                  ? "最后一条可达 FINAL_NATIVE_TEXT"
                  : n === 1
                    ? "独特关键词 native-search-hit"
                    : "合成消息 " + n,
          },
        ],
      })),
    }),
  );
  await fs.mkdir(path.join(roots.cursor, "logs"), { recursive: true });
  const dbPath = path.join(roots.cursor, "User/globalStorage/state.vscdb");
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE,value BLOB);CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE,value BLOB)",
  );
  db.prepare("INSERT INTO ItemTable VALUES (?,?)").run(
    "synthetic-settings-sentinel",
    "fixture only, never returned by conversation reader",
  );
  const put = (key, value) =>
    db
      .prepare("INSERT INTO cursorDiskKV VALUES (?,?)")
      .run(key, JSON.stringify(value));
  put("composerData:synthetic-conversation", {
    composerId: "synthetic-conversation",
    name: "本地对话合成验证 00",
    createdAt: Date.parse(created),
    lastUpdatedAt: Date.parse(updated),
    fullConversationHeadersOnly: Array.from({ length: 40 }, (_, n) => ({
      bubbleId: "bubble-" + n,
    })),
  });
  for (let n = 0; n < 40; n++)
    put(`bubbleId:synthetic-conversation:bubble-${n}`, {
      bubbleId: "bubble-" + n,
      type: n % 2 ? 2 : 1,
      createdAt: new Date(Date.parse(created) + n * 60000).toISOString(),
      text:
        n === 0
          ? "本地对话合成验证 00"
          : n === 39
            ? "最后一条可达 FINAL_NATIVE_TEXT"
            : n === 1
              ? "独特关键词 native-search-hit"
              : "合成消息 " + n,
    });
  db.close();
  originalFiles.push(dbPath);
  return { roots, originalFiles, created, updated };
}
