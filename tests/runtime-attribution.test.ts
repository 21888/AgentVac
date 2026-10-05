import test from "node:test";
import assert from "node:assert/strict";
import { claudeCodeAdapter as adapter } from "../electron/providers/claude-code.js";
const uncertain: [string, string][] = [
  ["python3", "python3 /tmp/ordinary.py suffix/claude_agent_sdk/launch"],
  [
    "node",
    "node /tmp/ordinary.js suffix/@anthropic-ai/claude-agent-sdk/launch",
  ],
  ["bun", "bun /tmp/ordinary.ts suffix/@anthropic-ai/claude-agent-sdk/launch"],
  ["node", "node /tmp/extensionless payload.js"],
  ["nodejs", "nodejs /tmp/extensionless payload.mjs"],
  ["bun", "bun /tmp/extensionless payload.ts"],
  ["bun", "bun run package-task payload.js"],
  ["python3", "python3 /tmp/extensionless payload.py"],
  [
    "node",
    "node /tmp/synthetic application/@anthropic-ai/claude-agent-sdk/index.js",
  ],
  [
    "python3",
    "python3 /tmp/synthetic application/claude_agent_sdk/__main__.py",
  ],
  ["node", "node --title innocent.js /tmp/extensionless"],
  ["node", "node --openssl-config innocent.js /tmp/extensionless"],
  ["node", "node --conditions innocent.js /tmp/extensionless"],
  ["node", "node --unknown innocent.js /tmp/extensionless"],
  ["node", "node --require innocent.js /tmp/extensionless"],
  ["node", "node --loader innocent.mjs /tmp/extensionless"],
  ["node", "node -r innocent.js /tmp/extensionless"],
  ["node", "node --import=innocent.mjs /tmp/extensionless"],
  ["node", "node -econsole.log(1) payload.js"],
  ["node", "node -p1 payload.js"],
  ["python3", "python3 -cprint(1) payload.py"],
  ["python3", "python3 -munknown payload.py"],
  ["python3", "python3 -m unknown payload.py"],
  ["python3", "python3 -W warning.py /tmp/extensionless"],
  ["python3", "python3 -X feature.py /tmp/extensionless"],
  ["python3", "python3 --check-hash-based-pycs always.py /tmp/extensionless"],
  ["python3", "python3 --unknown innocent.py /tmp/extensionless"],
  ["bun", "bun --eval innocent.js"],
  ["bun", "bun --cwd innocent.js /tmp/extensionless"],
  ["bun", "bun run --unknown innocent.js /tmp/extensionless"],
  ["node", "node - payload.js"],
  ["python3", "python3 - payload.py"],
  ["bun", "bun - payload.ts"],
];
for (const [name, commandLine] of uncertain)
  test("never attribute later text: " + commandLine, () =>
    assert.notEqual(
      adapter.assessProcesses({
        platform: "linux",
        complete: true,
        processes: [{ name, commandLine }],
      }).status,
      "clear",
    ),
  );
for (const [name, commandLine] of [
  ["node", "node /tmp/unrelated.js"],
  ["nodejs", "nodejs /tmp/unrelated.mjs"],
  ["bun", "bun /tmp/unrelated.ts"],
  ["python3", "python3 /tmp/unrelated.py"],
])
  test(
    "ordinary explicit unrelated first script remains clear: " + commandLine,
    () =>
      assert.equal(
        adapter.assessProcesses({
          platform: "linux",
          complete: true,
          processes: [{ name, commandLine }],
        }).status,
        "clear",
      ),
  );
for (const [name, commandLine] of [
  ["node", "node /tmp/@anthropic-ai/claude-agent-sdk/index.js"],
  [
    "node",
    "node --require /tmp/@anthropic-ai/claude-agent-sdk/index.js /tmp/unrelated.js",
  ],
  ["python3", "python3 -m claude_agent_sdk"],
  ["python3", "python3 -W ignore /tmp/claude_agent_sdk/__main__.py"],
])
  test("known SDK entrypoint stays running: " + commandLine, () =>
    assert.equal(
      adapter.assessProcesses({
        platform: "linux",
        complete: true,
        processes: [{ name, commandLine }],
      }).status,
      "running",
    ),
  );

import { clineAdapter } from "../electron/providers/cline.js";
import { cursorAdapter } from "../electron/providers/cursor.js";
for (const provider of [adapter, clineAdapter, cursorAdapter])
  for (const separator of ["\t", "\u00a0", "\u2003"])
    test(`${provider.id}: non-ASCII/control whitespace cannot hide extra raw operands ${JSON.stringify(separator)}`, () => {
      assert.notEqual(
        provider.assessProcesses({
          platform: "linux",
          complete: true,
          processes: [
            {
              name: "node",
              commandLine: `node /tmp/ordinary.js${separator}suffix/private-agent/entry.js`,
            },
          ],
        }).status,
        "clear",
      );
    });
