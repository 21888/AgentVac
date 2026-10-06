const MAX_UTF8 = 16384, MAX_UTF16 = 4096;
export const codes = Object.freeze(['verified-local','verified-private','invalid-request','locality-rejected','acl-rejected','metadata-unavailable','timeout','identity-unavailable']);
const fail = () => { throw new Error('invalid-protocol'); };
export function canonicalize(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_UTF16 || !value.isWellFormed() || /[\x00-\x1f\x7f]/.test(value)) return null;
  let candidate;
  if (value.startsWith('\\\\?\\')) { if (value.includes('/')) return null; candidate = value.slice(4); }
  else { if (!/^[a-zA-Z]:[\\/]/.test(value)) return null; candidate = value.replace(/\//g,'\\'); }
  if (!/^[a-zA-Z]:\\/.test(candidate)) return null;
  const parts = candidate.slice(3).split('\\'); if (parts.at(-1) === '') parts.pop();
  if (parts.length > 128 || parts.some(p => !p || p === '.' || p === '..' || /[<>:"|?*]/.test(p) || /[ .]$/.test(p) || /^(?:CON|CONIN\$|CONOUT\$|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(p))) return null;
  return candidate[0].toUpperCase() + ':\\' + parts.join('\\');
}
export function encodeRequest({path, mode, directory = false, allowMissingLeaf = false}) {
  const normalized = canonicalize(path);
  if (!normalized || !['locality','acl'].includes(mode) || typeof directory !== 'boolean' || typeof allowMissingLeaf !== 'boolean' || (allowMissingLeaf && (mode !== 'locality' || !directory))) fail();
  const utf8 = Buffer.from(normalized,'utf8'); if (utf8.length > MAX_UTF8) fail();
  const frame = Buffer.alloc(12 + utf8.length); frame.writeUInt32LE(8 + utf8.length,0); frame.write('AVM1',4,'ascii');
  frame[8] = Number(mode === 'acl'); frame[9] = Number(directory) | (Number(allowMissingLeaf) << 1); utf8.copy(frame,12); return frame;
}
export function decodeResponse(frame, request) {
  if (!Buffer.isBuffer(frame) || frame.length !== 68 || frame.readUInt32LE(0) !== 64 || !frame.subarray(4,8).equals(Buffer.from([65,86,77,49]))) fail();
  const body = frame.subarray(4), code = body[4], flags = body[5];
  if (code >= codes.length || ![0,5,7].includes(flags) || body[6] || body[7]) fail();
  if (code > 1) { if (flags || body.subarray(8).some(Boolean)) fail(); return Object.freeze({outcome:codes[code]}); }
  if ((code === 1) !== (request.mode === 'acl')) fail();
  if (!flags) { if (!request.allowMissingLeaf || code !== 0 || body.subarray(8).some(Boolean)) fail(); return Object.freeze({outcome:codes[code], exists:false}); }
  const directory = (flags & 2) !== 0;
  const attrs = body.readUInt32LE(36), links = body.readUInt32LE(32);
  if ((request.directory && !directory) || !!(attrs & 0x10) !== directory || attrs & 0x400 || !links || body.readBigUInt64LE(8) > 0xffffffffn) fail();
  return Object.freeze({outcome:codes[code], exists:true, directory,
    identity:Object.freeze({volume32:body.readBigUInt64LE(8).toString(16).padStart(8,'0'), fileIndex64:body.readBigUInt64LE(16).toString(16).padStart(16,'0'), size:body.readBigUInt64LE(24).toString(), links, volume64:body.readBigUInt64LE(40).toString(16).padStart(16,'0'), fileId128:body.subarray(48,64).toString('hex')})});
}
