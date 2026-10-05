import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  displayText,
  textChunk,
  virtualWindow,
  dateBoundary,
  hiddenSelection,
  formatConversationTime,
  formatConversationSize,
} from "../src/conversations/presentation.js";
test("conversation rendering preserves hostile HTML, URLs and command content as plain text", () => {
  const hostile =
    '<img src="https://example.invalid/beacon" onerror="alert(1)">\n[jump](javascript:alert(1))\nfile:///secret\n$(rm -rf /)';
  assert.deepEqual(displayText(hostile), {
    blocks: [{ kind: "text", text: hostile }],
    truncated: false,
  });
});
test("fenced code becomes an inert plain code block and preserves text order", () => {
  assert.deepEqual(
    displayText('Before\n```ts\nconst a = "<script>";\n```\nAfter').blocks,
    [
      { kind: "text", text: "Before" },
      { kind: "code", text: 'const a = "<script>";', language: "ts" },
      { kind: "text", text: "After" },
    ],
  );
});
test("message rendering bounds long text and reports every omitted suffix", () => {
  const result = displayText("x".repeat(100000));
  assert.equal(result.blocks[0].text.length, 12000);
  assert.equal(result.truncated, true);
  assert.equal(
    displayText("x".repeat(100000), Infinity).blocks[0].text.length,
    48000,
  );
});
test("malformed fence languages are never treated as attributes or tags", () => {
  assert.equal(displayText("```<script>\nhello\n```").blocks[0].kind, "text");
});
test("virtual conversation windows have bounded DOM even for million-row histories", () => {
  for (const scroll of [0, 1000, 50_000_000, 99_999_990]) {
    const window = virtualWindow(1_000_000, scroll, 500);
    assert.ok(window.end - window.start <= 11);
    assert.equal(
      window.before + (window.end - window.start) * 100 + window.after,
      100_000_000,
    );
  }
  assert.ok(virtualWindow(10000, 0, 100000).end <= 46);
  assert.deepEqual(virtualWindow(0, 99999, 500), {
    start: 0,
    end: 0,
    before: 0,
    after: 0,
  });
});
test("hidden selection means other result pages, not rows outside the virtual viewport", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(
    hiddenSelection(
      new Map(rows.map((row) => [row.id, row])),
      rows.slice(0, 2),
    ),
    [{ id: "c" }],
  );
});
test("time filters create exclusive next-local-day boundaries and reject invalid dates", () => {
  assert.equal(dateBoundary(""), undefined);
  const start = new Date(dateBoundary("2026-10-05")!);
  const end = new Date(dateBoundary("2026-10-05", true)!);
  assert.equal(start.getHours(), 0);
  assert.equal(start.getDate(), 5);
  assert.equal(end.getHours(), 0);
  assert.equal(end.getDate(), 6);
  assert.equal(end.getMilliseconds(), 0);
  for (const value of ["2026-02-30", "2026-13-01", "../x", "2026-1-1"])
    assert.throws(() => dateBoundary(value));
});
test("missing conversation time never substitutes a file modification date", () => {
  assert.equal(formatConversationTime(null), "未知时间");
  assert.equal(formatConversationTime("nope"), "未知时间");
  assert.equal(formatConversationSize(-1), "大小未知");
  assert.equal(formatConversationSize(1024), "1.0 KB");
});

test("date filter ranges follow DST calendar days instead of adding 24 hours", () => {
  const script = `import { dateBoundary } from './src/conversations/presentation.ts'; console.log(JSON.stringify(['2026-03-08','2026-11-01'].map(day => [dateBoundary(day),dateBoundary(day,true)])));`;
  const ranges = JSON.parse(
    execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: process.cwd(),
        env: { ...process.env, TZ: "America/New_York" },
        encoding: "utf8",
      },
    ),
  );
  assert.equal(
    new Date(ranges[0][1]).getTime() - new Date(ranges[0][0]).getTime(),
    23 * 3600000,
  );
  assert.equal(
    new Date(ranges[1][1]).getTime() - new Date(ranges[1][0]).getTime(),
    25 * 3600000,
  );
});
test("bounded text continuation preserves complete emoji and multilingual content", () => {
  const source = "a".repeat(11999) + "🧭中文".repeat(4000) + "完整末尾";
  const chunks = [];
  let offset = 0;
  do {
    const chunk = textChunk(source, offset);
    chunks.push(chunk.text);
    assert.ok(chunk.end > offset);
    offset = chunk.end;
  } while (offset < source.length);
  assert.equal(chunks.join(""), source);
  assert.equal(
    chunks
      .flatMap((chunk) =>
        displayText(chunk, chunk.length).blocks.map((block) => block.text),
      )
      .join(""),
    source,
  );
  for (const chunk of chunks) {
    assert.ok(!/^[\uDC00-\uDFFF]/.test(chunk));
    assert.ok(!/[\uD800-\uDBFF]$/.test(chunk));
  }
  assert.equal(textChunk("a🧭b", 2, 1).text, "🧭");
});
test("many fenced fragments preserve content while bounding element-producing blocks", () => {
  const source = Array.from(
    { length: 500 },
    (_, index) => `text ${index}\n\`\`\`js\ncode ${index}\n\`\`\``,
  ).join("\n");
  const result = displayText(source);
  assert.ok(result.blocks.length <= 7);
  assert.ok(result.blocks.at(-1)!.text.includes("code 20"));
});
