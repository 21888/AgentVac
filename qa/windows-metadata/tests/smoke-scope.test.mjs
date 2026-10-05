import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('native smoke does not inspect profile/public roots outside generated fixtures',async()=>{
  const source=await readFile(new URL('../scripts/native-smoke.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/await inspect\(path\.parse\(build\)\.root/);
  assert.doesNotMatch(source,/process\.env\.(?:USERPROFILE|PUBLIC)\b/);
  for(const id of ['profile-root-candidate','public-root-candidate'])
    assert.ok(source.includes(`id:'${id}',status:'UNAVAILABLE',actual:'outside-generated-fixture-scope'`));
  assert.ok(source.includes("await mkdtemp(path.join(build,'metadata-smoke-'))"));
});
