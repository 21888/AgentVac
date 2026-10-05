import {createHash} from 'node:crypto';
import {open, lstat, realpath} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {canonicalize, encodeRequest, decodeResponse} from './protocol.mjs';

// Research-only: no shipping receipt is present. Only a reviewed native runner
// or trusted installer may supply the exact binding below. Never accept it from
// conversation content, request data, environment, PATH or a discovered executable.
export function validateBinding(binding) {
  return binding?.schema === 1 && typeof binding.systemRoot === 'string' && /^[A-Z]:\\Windows$/.test(binding.systemRoot) && canonicalize(binding.helperPath) === binding.helperPath &&
    path.win32.basename(binding.helperPath) === 'agentvac-metadata-research.exe' &&
    /^[a-f0-9]{64}$/.test(binding.helperSha256 ?? '') && /^[a-f0-9]{64}$/.test(binding.sourceTreeSha256 ?? '') &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(binding.reviewId ?? '') && binding.bootstrap === 'trusted-local-nonreparse-installation';
}
export async function inspectReviewed(binding, request, signal) {
  // Snapshot trusted inputs before the first await; never hash one path then spawn a mutable replacement.
  binding = Object.freeze({...binding}); request = Object.freeze({...request});
  const result = outcome => Object.freeze({outcome});
  if (signal?.aborted) return result('cancelled');
  if (process.platform !== 'win32') return result('not-windows');
  if (!validateBinding(binding)) return result('unreviewed-helper');
  let input;
  try { input = encodeRequest(request); } catch { return result('invalid-request'); }
  let handle;
  try {
    // Defense in depth only: native-local trusted packaging must already establish
    // executable + ancestor integrity. lstat/realpath/hash do not remove spawn TOCTOU.
    const listed = await lstat(binding.helperPath,{bigint:true});
    const resolved = await realpath(binding.helperPath);
    if (!listed.isFile() || listed.isSymbolicLink() || resolved.toLowerCase() !== binding.helperPath.toLowerCase()) return result('unreviewed-helper');
    handle = await open(binding.helperPath,'r');
    const before = await handle.stat({bigint:true});
    if (!before.isFile() || before.size < 1n || before.size > 8n * 1024n * 1024n || before.ino !== listed.ino || before.dev !== listed.dev) return result('unreviewed-helper');
    const hash = createHash('sha256'), chunk = Buffer.alloc(65536); let total=0;
    while (true) { if (signal?.aborted) return result('cancelled'); const {bytesRead} = await handle.read(chunk,0,chunk.length,total); if (!bytesRead) break; total+=bytesRead; if (total > 8*1024*1024) return result('unreviewed-helper'); hash.update(chunk.subarray(0,bytesRead)); }
    const after = await handle.stat({bigint:true});
    if (before.size !== BigInt(total) || before.size !== after.size || before.ino !== after.ino || before.dev !== after.dev || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || hash.digest('hex') !== binding.helperSha256) return result('unreviewed-helper');
    if (signal?.aborted) return result('cancelled');
    return await new Promise(resolve => {
      let child, done = false, timer; const output=[]; let bytes=0;
      const finish = outcome => { if(done) return; done=true; clearTimeout(timer); signal?.removeEventListener('abort',cancel); if(child?.exitCode === null && child?.signalCode === null) {try {child.kill();} catch {}} for(const b of output) b.fill(0); input.fill(0); resolve(typeof outcome === 'string' ? result(outcome) : outcome); };
      const cancel = () => finish('cancelled');
      try { child=spawn(binding.helperPath,[],{shell:false,windowsHide:true,cwd:path.win32.dirname(binding.helperPath),env:{SystemRoot:binding.systemRoot,WINDIR:binding.systemRoot,SystemDrive:binding.systemRoot.slice(0,2),USERPROFILE:'',APPDATA:'',LOCALAPPDATA:'',TEMP:'',TMP:'',HOMEDRIVE:'',HOMEPATH:'',PATH:''},stdio:['pipe','pipe','pipe']}); }
      catch {finish('spawn-failed'); return;}
      timer=setTimeout(()=>finish('timeout'),5000); signal?.addEventListener('abort',cancel,{once:true});
      child.stdout.on('data',chunk=>{if(done)return; bytes+=chunk.length; if(bytes>68)finish('invalid-output');else output.push(Buffer.from(chunk));});
      child.stderr.on('data',()=>finish('invalid-output'));
      child.stdout.on('error',()=>finish('helper-failed')); child.stderr.on('error',()=>finish('helper-failed')); child.stdin.on('error',()=>finish('helper-failed'));
      child.on('error',()=>finish('spawn-failed'));
      child.once('close',code=>{ if(done)return; if(signal?.aborted)finish('cancelled'); else if(code===124)finish('timeout'); else if(code!==0)finish('helper-failed'); else {try {finish(decodeResponse(Buffer.concat(output,bytes),request));}catch{finish('invalid-output');}} });
      if(signal?.aborted){cancel();return;} child.stdin.end(input);
    });
  } catch { return result('unreviewed-helper'); }
  finally { input?.fill(0); if(handle) {try {await handle.close();}catch{}} }
}
