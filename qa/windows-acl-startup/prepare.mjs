import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, verifySource, verifyArtifacts } from './pins.mjs';

export const ADAPTER = `import { spawn as nativeSpawn } from 'node:child_process';
import { observeSpawn } from './observer.mjs';
export function spawn(...args) { return observeSpawn(nativeSpawn, this, args); }
`;

// Only this exact source module may route its child_process import to the adapter.
// Every other import is explicitly enumerated; no filesystem loader is used.
export function sourceRoutingPlugin(source, adapter = ADAPTER) {
  return {
    name: 'pinned-read-only-observation',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point' && args.path === 'agentvac:frozen')
          return { path: 'frozen-helper.ts', namespace: 'frozen' };
        if (args.namespace === 'frozen' && args.importer === 'frozen-helper.ts') {
          if (args.path === 'node:child_process')
            return { path: 'spawn-adapter.mjs', namespace: 'adapter' };
          if (args.path === 'node:path') return { path: args.path, external: true };
        }
        if (args.namespace === 'adapter' && args.importer === 'spawn-adapter.mjs' &&
            ['node:child_process', './observer.mjs'].includes(args.path))
          return { path: args.path, external: true };
        return { errors: [{ text: 'BLOCKED_SOURCE_ROUTING' }] };
      });
      build.onLoad({ filter: /^frozen-helper\.ts$/, namespace: 'frozen' }, () =>
        ({ contents: source, loader: 'ts' }));
      build.onLoad({ filter: /^spawn-adapter\.mjs$/, namespace: 'adapter' }, () =>
        ({ contents: adapter, loader: 'js' }));
    },
  };
}

export async function bundleSource(esbuild, source, adapter = ADAPTER) {
  const result = await esbuild.build({
    entryPoints: ['agentvac:frozen'], plugins: [sourceRoutingPlugin(source, adapter)],
    bundle: true, write: false, platform: 'node', format: 'esm', target: 'node22',
    legalComments: 'none', sourcemap: false, charset: 'utf8', logLevel: 'silent',
    treeShaking: false, minify: false,
  });
  if (result.outputFiles.length !== 1) throw new Error('BUNDLE_SHAPE');
  return result.outputFiles[0].contents;
}

export async function prepare(sourceRoot, root) {
  const artifacts = await verifyArtifacts(root, false);
  const lock = JSON.parse(await readFile(path.join(root, 'source-lock.json'), 'utf8'));
  const source = await verifySource(sourceRoot, lock);
  const require = createRequire(path.join(sourceRoot, 'package.json'));
  const esbuild = require('esbuild');
  if (esbuild.version !== lock.esbuildVersion) throw new Error('BUILD_CAPABILITY');
  const bundle = await bundleSource(esbuild, source);
  const expected = artifacts.files['helper.observed.mjs'];
  if (bundle.length !== expected.bytes || sha256(bundle) !== expected.sha256)
    throw new Error('BUNDLE_PIN');
  await writeFile(path.join(root, 'helper.observed.mjs'), bundle);
  await verifyArtifacts(root);
  return { status: 'PREPARED_SOURCE_ONLY', sourcePinned: true, bundlePinned: true, productionAccepted: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--source-dir') throw new Error('INPUT');
    const result = await prepare(path.resolve(process.argv[3]), path.dirname(fileURLToPath(import.meta.url)));
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch {
    process.stdout.write('{"status":"BLOCKED","reason":"SOURCE_OR_BUILD_CAPABILITY","productionAccepted":false}\n');
    process.exitCode = 2;
  }
}
