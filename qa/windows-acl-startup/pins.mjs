import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const HELPER = 'electron/conversations/cursor-windows-acl.ts';
export const RUNTIME_FILES = [
  'source-lock.json', 'pins.mjs', 'observer.mjs', 'run.mjs',
  'prepare.mjs', 'helper.observed.mjs',
];

export async function verifySource(sourceRoot, lock) {
  const [source, manifest] = await Promise.all([
    readFile(path.join(sourceRoot, HELPER)),
    readFile(path.join(sourceRoot, 'SOURCE-SHA256.json')),
  ]);
  if (source.length !== lock.helperBytes || sha256(source) !== lock.helperSha256)
    throw new Error('SOURCE_PIN');
  // The publication manifest changes when QA sources are added. Pin this exact
  // helper record, not a circular hash of a manifest containing this packet.
  const records = JSON.parse(manifest).files;
  const matchesInManifest = Array.isArray(records) ? records.filter((v) => v?.path === HELPER) : [];
  if (matchesInManifest.length !== 1 || matchesInManifest[0].sha256 !== lock.helperSha256 ||
      matchesInManifest[0].bytes !== lock.helperBytes) throw new Error('SOURCE_PIN');
  const text = source.toString('utf8');
  const matches = [...text.matchAll(/const SCRIPT = String.raw`([\s\S]*?)`;/g)];
  if (matches.length !== 1 || matches[0][1].includes('${')) throw new Error('SCRIPT_PIN');
  const script = Buffer.from(matches[0][1], 'utf16le');
  if (script.length !== lock.scriptUtf16Bytes || sha256(script) !== lock.scriptSha256 ||
      script.toString('base64').length !== lock.scriptBase64Chars) throw new Error('SCRIPT_PIN');
  return text;
}

export async function verifyArtifacts(root, requireBundle = true) {
  const lock = JSON.parse(await readFile(path.join(root, 'artifact-lock.json'), 'utf8'));
  if (lock.format !== 'agentvac-acl-startup-artifacts-v1' ||
      Object.keys(lock.files).sort().join('|') !== [...RUNTIME_FILES].sort().join('|'))
    throw new Error('ARTIFACT_PIN');
  for (const name of RUNTIME_FILES) {
    if (!requireBundle && name === 'helper.observed.mjs') continue;
    const bytes = await readFile(path.join(root, name));
    const expected = lock.files[name];
    if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256)
      throw new Error('ARTIFACT_PIN');
  }
  return lock;
}
