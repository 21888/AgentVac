import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=new URL('../',import.meta.url);
const inputs=['.gitattributes','include/core.hpp','include/inherited-context.hpp','include/inherited-policy.hpp','include/inherited-request.hpp','src/native-helper.cpp','src/fixture-constructor.cpp','src/helper.manifest','protocol.mjs','inherited-protocol.mjs','research-transport.mjs','tests/core.test.cpp','tests/inherited-policy.test.cpp','scripts/build-inherited-windows.ps1','scripts/native-inherited.mjs','scripts/source-manifest.mjs'].sort();
const hash=b=>createHash('sha256').update(b).digest('hex'),sources={};
for(const relative of inputs)sources[relative]=hash(await readFile(new URL(relative,root)));
const sourceTreeSha256=hash(Buffer.from(inputs.map(p=>`${p}\0${sources[p]}\n`).join('')));
const result={schema:1,profile:'same-caller-inherited-context-v1',status:'source-staged-not-native-accepted',sourceTreeSha256,sources,baselineSourceTreeSha256:'d999a79bcf418480e8fd8efa144b5917a900d01cbb1cbd1f916ec738d97c1fa2',diagnosticSourceTreeSha256:'f0f64721b5fdbb505891c8d8aeb3ca9f43968bd34b64f4086b2b240508564e59',policySourceSha256:'497f00ba1caedfccb02e0ac69a1812cfaf6b37b301334c177cffb71f4f6a8dfd',nativeWindows:'NOT_RUN'};
await writeFile(new URL('results/source-manifest.json',root),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({sourceTreeSha256,nativeWindows:'NOT_RUN'}));
