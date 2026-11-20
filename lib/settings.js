const fs = require('node:fs');
const path = require('node:path');
const {parse, modify, applyEdits} = require('../vendor/jsonc-parser/lib/umd/main.js');

// Cursor's settings.json is JSONC (it ships comments). Writing it with
// JSON.parse would drop those comments, so the proxy journal records the
// original text and every edit goes through jsonc-parser's modify/applyEdits.

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function replace(temp, file) {
  for (let attempt = 0; ; attempt += 1) {
    try { fs.renameSync(temp, file); return; } catch (error) {
      // Windows refuses to rename over a file another process has open
      // (EPERM/EBUSY). Back off briefly and retry instead of losing the write.
      const retry = process.platform === 'win32'
        && ['EPERM', 'EBUSY', 'EACCES'].includes(error.code)
        && attempt < 4;
      if (!retry) throw error;
      sleep(20 * (attempt + 1));
    }
  }
}

function atomic(file, text) {
  fs.mkdirSync(path.dirname(file), {recursive:true, mode:0o700});
  const temp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temp, 'w', 0o600);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  replace(temp, file);
}

// The service re-reads Cursor's settings every couple of seconds. Parsing
// the same 10–50 KB JSONC document over and over is pure overhead, so keep
// the last parse keyed by the file identity. External edits change mtime/size
// and invalidate it; our own atomic writes replace the inode.
const documents = new Map();
function document(file) {
  let info = null;
  try { info = fs.statSync(file); } catch { /* missing file */ }
  const signature = info ? `${info.mtimeMs}:${info.size}:${info.ino}` : '';
  const cached = documents.get(file);
  if (cached && signature && cached.signature === signature) return {text: cached.text, data: cached.data};
  const text = info ? fs.readFileSync(file,'utf8') : '{}\n';
  const errors = [];
  const data = parse(text, errors, {allowTrailingComma:true});
  if (errors.length || !data || Array.isArray(data) || typeof data !== 'object') throw new Error('invalid settings JSONC');
  if (signature) documents.set(file, {signature, text, data});
  else documents.delete(file);
  return {text,data};
}

const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const state = (data,k) => Object.hasOwn(data,k) ? {exists:true,value:data[k]} : {exists:false};
function edit(text,k,s) {
  return applyEdits(text, modify(text,[k],s.exists ? s.value : undefined,{formattingOptions:{insertSpaces:true,tabSize:2,eol:text.includes('\r\n')?'\r\n':'\n'}}));
}

function desiredProxySettings(proxy) {
  return {
    'http.proxy':proxy, 'http.proxyKerberosServicePrincipal':proxy,
    'http.proxySupport':'on', 'cursor.general.disableHttp2':true,
    'http.experimental.systemCertificatesV2':true, 'http.noProxy':[]
  };
}

function applyProxy(settings, journalFile, proxy) {
  const desired = desiredProxySettings(proxy);
  const {text,data} = document(settings);
  const previous = fs.existsSync(journalFile) ? JSON.parse(fs.readFileSync(journalFile,'utf8')) : null;
  if (previous && previous.settings !== settings) throw new Error('journal settings path differs');
  const journal = previous || {settings,entries:{},originalText:text};
  let updated = text;
  for (const [key,value] of Object.entries(desired)) {
    const applied = value === undefined ? {exists:false} : {exists:true,value};
    const prior = journal.entries[key];
    if (prior && !equal(state(data,key),prior.applied)) throw new Error('Cursor proxy settings changed externally; bridge paused');
    journal.entries[key] = {before:prior?.before || state(data,key), applied};
    updated = edit(updated,key,applied);
  }
  // Durable undo information precedes the settings write.
  if (previous && updated === text && previous.appliedText === updated) return;
  journal.appliedText=updated;
  atomic(journalFile,JSON.stringify(journal,null,2));
  if (updated !== text) atomic(settings,updated);
}

function restoreProxy(journalFile) {
  if (!fs.existsSync(journalFile)) return [];
  const journal=JSON.parse(fs.readFileSync(journalFile,'utf8'));
  const {text,data}=document(journal.settings);
  if (text===journal.appliedText && typeof journal.originalText==='string') {
    atomic(journal.settings,journal.originalText);fs.unlinkSync(journalFile);return [];
  }
  let updated=text;
  const skipped=[];
  for (const [key,entry] of Object.entries(journal.entries)) {
    if (equal(state(data,key),entry.applied)) updated=edit(updated,key,entry.before);
    else if (!equal(state(data,key),entry.before)) skipped.push(key);
  }
  if (updated!==text) atomic(journal.settings,updated);
  fs.unlinkSync(journalFile);
  return skipped;
}

// Read-only view used by the console: are we currently the proxy owner?
function proxyState(settings, journalFile, expected) {
  const journaled = fs.existsSync(journalFile);
  let current = null;
  try { current = document(settings).data['http.proxy'] ?? null; } catch { /* unreadable */ }
  return {journaled, current, expected, active: !!expected && current === expected};
}

module.exports = {
  atomic,
  document,
  applyProxy,
  restoreProxy,
  proxyState,
  desiredProxySettings
};