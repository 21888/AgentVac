// Log-only CI reporting: no upload, publishing, cache or filesystem mutation.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const evidence = path.join(path.dirname(fileURLToPath(import.meta.url)), 'evidence');
let found = 0;
for (const entry of await fs.readdir(evidence, { withFileTypes: true }).catch(error => {
  if (error.code === 'ENOENT') return [];
  throw error;
})) {
  if (!entry.isDirectory()) continue;
  const file = path.join(evidence, entry.name, 'result.json');
  try {
    const report = JSON.parse(await fs.readFile(file, 'utf8'));
    console.log(JSON.stringify({ target: report.target, verdict: report.verdict, inputProvenance: report.inputProvenance || { kind: 'frozen-release-input-before-provenance-field' }, startedAt: report.startedAt, finishedAt: report.finishedAt, nativeLaunchAttempted: report.nativeLaunchAttempted, packagedRuntimeVerified: report.packagedRuntimeVerified, checks: report.checks, separateReleaseGates: report.separateReleaseGates, cleanup: report.cleanup }, null, 2));
    found++;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
if (!found) { console.error('UNTESTED: no packaged acceptance result exists. Inspect the preceding build/setup step.'); process.exitCode = 1; }
