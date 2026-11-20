'use strict';

// Layered self-check. Every layer answers one question a user would ask when
// Cursor shows an error: is the service alive, is the certificate trusted, is
// the proxy ours, can the upstream be reached, does the catalogue have models?
// The console renders the same structure in order, so a failure points at the
// layer that actually broke instead of a generic "bridge unavailable".

function item(layer, id, name, status, detail, hint = null) {
  return {layer, id, name, status, detail, hint};
}

function run(snapshot) {
  const layers = [];
  const m = snapshot || {};

  // 1. Service and processes
  const service = m.service || {};
  layers.push(item('service', 'service', '桥接服务', service.running ? 'ok' : 'fail',
    service.running ? `运行中，控制端口 ${service.port || '未知'}` : '服务未运行',
    service.running ? null : '打开控制台点击「启用桥接」；若反复失败，运行 ~/.cursor-bridge 下的救援脚本。'));
  layers.push(item('service', 'engine', '原生引擎', m.engine?.running ? 'ok' : 'fail',
    m.engine?.running ? `PID ${m.engine.pid}，代理 ${m.engine.proxy}` : '未运行',
    m.engine?.running ? null : '查看引擎日志；证书未信任或平台二进制缺失是最常见原因。'));
  layers.push(item('service', 'shim', '本地中继', m.shim?.running ? 'ok' : 'fail',
    m.shim?.running ? `127.0.0.1:${m.shim.port}` : '未运行',
    m.shim?.running ? null : '中继随服务启动；请重启桥接。'));

  // 2. Certificate
  const cert = m.cert || {};
  layers.push(item('certificate', 'ca', '本地 CA', cert.exists ? 'ok' : 'fail',
    cert.exists ? cert.path : '尚未生成',
    cert.exists ? null : '点击「初始化证书」。'));
  layers.push(item('certificate', 'trust', '证书信任', cert.trusted ? 'ok' : 'fail',
    cert.trusted ? (cert.detail || '已信任') : (cert.detail || '未受信任'),
    cert.trusted ? null : '点击「信任证书」；macOS 会要求钥匙串密码，Windows 会要求管理员确认。'));

  // 3. Proxy
  const proxy = m.proxy || {};
  layers.push(item('proxy', 'ownership', '代理接管', proxy.active ? 'ok' : (proxy.journaled ? 'warn' : 'fail'),
    proxy.active ? `http.proxy = ${proxy.current}` : (proxy.current ? `当前 http.proxy = ${proxy.current}` : 'Cursor 未设置 http.proxy'),
    proxy.active ? null : '点击「启用桥接」写入代理，然后重启 Cursor。'));
  if (proxy.restartRequired) {
    layers.push(item('proxy', 'restart', '等待重启', 'warn', '代理已写入，但当前 Cursor 进程仍使用旧网络设置',
      '请完全退出并重新打开 Cursor（仅重载窗口通常不够）。'));
  }
  const conflicts = m.conflicts || {};
  if (conflicts.detected) {
    for (const conflict of conflicts.items || []) {
      layers.push(item('proxy', conflict.id, conflict.title, 'fail', conflict.detail, conflict.action));
    }
  }

  // 4. Upstreams
  for (const provider of m.providers || []) {
    layers.push(item('upstream', `provider-${provider.id}`, `${provider.name}（${provider.type}）`,
      provider.error ? 'warn' : 'ok',
      provider.error ? provider.error : `${provider.models} 个模型 · ${provider.baseUrl}`,
      provider.error ? '检查 Base URL、密钥与网络；Magpie 自动发现需要 Magpie → Agents 处于连接状态。' : null));
  }
  if (!(m.providers || []).length) {
    layers.push(item('upstream', 'providers', '上游提供者', 'fail', '尚未配置任何提供者', '导入 Magpie 连接或添加自定义 Base URL。'));
  }

  // 5. Catalogue
  const catalogue = m.catalogue || {};
  layers.push(item('catalogue', 'models', '模型目录', catalogue.count ? 'ok' : 'fail',
    catalogue.count ? `${catalogue.count} 个模型，默认 ${catalogue.defaultModel || '未选择'}` : '没有可用模型',
    catalogue.count ? null : '至少启用一个提供者，并确认它能返回模型列表。'));

  // 6. Database
  const db = m.db || {};
  layers.push(item('database', 'driver', '数据库驱动', db.driver ? 'ok' : 'warn',
    db.driver ? db.driver : (db.detail || '当前运行时不支持 node:sqlite'),
    db.driver ? null : '数据库统计不可用；调用记录仍可在「调用」页查看。'));
  layers.push(item('database', 'size', '引擎数据库', 'ok',
    db.file ? `${(db.sizeBytes / 1024 / 1024).toFixed(1)} MiB` : '尚未创建', null));

  const count = (status) => layers.reduce((total, entry) => total + (entry.status === status ? 1 : 0), 0);
  return {
    at: new Date().toISOString(),
    layers,
    summary: {ok: count('ok'), warn: count('warn'), fail: count('fail')}
  };
}

module.exports = {run};