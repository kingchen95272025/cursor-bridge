'use strict';
const fs = require('node:fs');
const path = require('node:path');

// A small bounded log. The engine writes request diagnostics to stderr, which
// can be loud; rotating at a fixed size keeps the extension's storage from
// growing without bound while still leaving the last failure readable.
class FileLog {
  constructor(file, limitBytes = 4 * 1024 * 1024) {
    this.file = file;
    this.limitBytes = limitBytes;
    this.fd = null;
    this.size = 0;
    fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
    try { this.size = fs.statSync(file).size; } catch { this.size = 0; }
  }

  rotateIfNeeded(incoming = 0) {
    if (this.size + incoming <= this.limitBytes) return;
    this.close();
    try { fs.renameSync(this.file, `${this.file}.1`); } catch { /* first run */ }
    this.size = 0;
  }

  close() {
    if (this.fd !== null) {
      try { fs.closeSync(this.fd); } catch { /* already closed */ }
      this.fd = null;
    }
  }

  open() {
    if (this.fd === null) {
      this.fd = fs.openSync(this.file, 'a', 0o600);
    }
    return this.fd;
  }

  line(message) {
    this.write(`${new Date().toISOString()} ${message}\n`);
  }

  write(text) {
    const bytes = Buffer.byteLength(text);
    try {
      this.rotateIfNeeded(bytes);
      fs.writeSync(this.open(), text);
      this.size += bytes;
    } catch { /* logging must never take the service down */ }
  }

  tail(lines = 200) {
    try {
      const text = fs.readFileSync(this.file, 'utf8');
      return text.split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
    } catch {
      return '';
    }
  }
}

module.exports = {FileLog};