'use strict';
const path = require('node:path');

// All durable state of the bridge lives under one root. The extension passes
// `context.globalStorageUri.fsPath`; the detached service receives the same
// path on its command line. Keeping the layout in one place means the console,
// the rescue script and the service can never disagree about where the
// journal or the engine database is.
function createPaths(root) {
  const j = (...parts) => path.join(root, ...parts);
  return {
    root,
    data: j('data'),
    logs: j('logs'),
    calls: j('calls'),
    backups: j('backups'),
    rescue: j('rescue'),
    config: j('config.json'),
    effective: j('effective.json'),
    status: j('status.json'),
    service: j('service.json'),
    lock: j('instance.lock'),
    journal: j('settings-journal.json'),
    engineLog: j('logs', 'engine.log'),
    serviceLog: j('logs', 'service.log'),
    bridgeDb: j('data', 'bridge.db'),
    caCert: j('data', 'ca', 'ca.crt'),
    caDir: j('data', 'ca')
  };
}

module.exports = {createPaths};