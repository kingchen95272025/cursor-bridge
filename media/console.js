/* global acquireVsCodeApi */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const $ = (selector) => document.querySelector(selector);

  let snapshot = null;
  let currentPage = 'overview';
  let pending = new Map();
  let sequence = 0;
  let callsRows = [];
  let callsOffset = 0;
  let dbView = null;
  let diagnosticsView = null;
  let modalState = null;
  let toastTimer = null;

  // ---- utilities ---------------------------------------------------------

  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'checked' || key === 'disabled' || key === 'selected') node[key] = !!value;
      else node.setAttribute(key, value);
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function fmtBytes(value) {
    if (!value) return '—';
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
    if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MiB`;
    return `${(value / 1024 / 1024 / 1024).toFixed(2)} GiB`;
  }

  function fmtTime(ts) {
    try {
      const date = new Date(ts);
      return date.toLocaleTimeString('zh-CN', {hour12: false});
    } catch { return '—'; }
  }

  function fmtNumber(value) {
    return Number(value || 0).toLocaleString('zh-CN');
  }

  function toast(text, bad = false) {
    const node = $('#toast');
    node.textContent = text;
    node.className = `toast${bad ? ' bad' : ''}`;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 4200);
  }

  function action(name, payload = {}, {timeout = 200000} = {}) {
    return new Promise((resolve, reject) => {
      const id = `a${++sequence}`;
      pending.set(id, {resolve, reject});
      vscode.postMessage({type: 'action', action: name, payload, id});
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`操作超时：${name}`));
        }
      }, timeout);
    });
  }

  function busy(button, promise) {
    if (!button) return promise;
    button.disabled = true;
    return promise.finally(() => { button.disabled = false; });
  }

  // ---- incoming messages -------------------------------------------------

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message) return;
    if (message.type === 'state') {
      snapshot = message.state;
      renderAll();
      return;
    }
    if (message.type === 'result') {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.ok) entry.resolve(message.data);
      else entry.reject(new Error(message.error || '操作失败'));
    }
  });

  // ---- state rendering ---------------------------------------------------

  const STATE = {
    connected: ['已连接', 'ok'],
    'needs-restart': ['代理已写入 · 待重启 Cursor', 'warn'],
    starting: ['启动中', 'warn'],
    'cert-missing': ['证书待信任', 'warn'],
    conflict: ['检测到冲突', 'bad'],
    error: ['错误', 'bad'],
    paused: ['已暂停', 'warn'],
    stopped: ['已停止', ''],
    unconfigured: ['未配置', ''],
    offline: ['服务离线', 'bad']
  };

  function renderAll() {
    renderStatus();
    renderBanners();
    if (currentPage === 'overview') renderOverview();
    if (currentPage === 'providers') renderProviders();
    if (currentPage === 'models') renderModels();
    if (currentPage === 'calls') { renderCallSummary(); renderCallTable(); }
    if (currentPage === 'database') renderDatabase();
    if (currentPage === 'diagnostics') renderDiagnostics();
  }

  function renderStatus() {
    const state = snapshot?.state || 'offline';
    const [text, tone] = STATE[state] || [state, ''];
    const badge = $('#statusBadge');
    badge.textContent = `${text}${snapshot?.detail ? ` · ${snapshot.detail}` : ''}`;
    badge.className = `status-badge ${tone}`;

    $('#serviceDot').className = `dot ${tone === 'ok' ? 'ok' : tone === 'bad' ? 'bad' : tone === 'warn' ? 'warn' : ''}`;
    $('#serviceLabel').textContent = snapshot?.service?.running
      ? `服务 :${snapshot.service.port || '—'}`
      : '服务离线';

    const engine = snapshot?.engine?.running;
    $('#btnStart').disabled = state === 'connected' || state === 'starting';
    $('#btnStop').disabled = !engine && !snapshot?.shim?.running;
    $('#btnRestart').disabled = !engine;
  }

  function renderBanners() {
    const root = $('#banners');
    root.replaceChildren();
    if (!snapshot) return;
    const add = (tone, title, lines, actions) => {
      root.append(h('div', {class: `banner ${tone}`},
        h('div', {},
          h('div', {class: 'banner-title', text: title}),
          ...lines.map((line) => h('div', {class: 'banner-text', text: line}))
        ),
        actions?.length ? h('div', {class: 'banner-actions'}, ...actions) : null
      ));
    };

    for (const item of snapshot.conflicts?.items || []) {
      add('bad', item.title, [item.detail, item.action], [
        h('button', {class: 'btn primary', onclick: () => busy($('#btnStart'), action('force-start').then(() => toast('已强制接管')).catch((error) => toast(error.message, true)))}, '强制接管')
      ]);
    }

    if (snapshot.state === 'cert-missing') {
      add('', '本地 CA 尚未受信任', [
        snapshot.cert?.detail || 'Cursor 无法信任桥接的 TLS 证书，代理因此未启用。',
        '信任后需要重新打开 Cursor 才能完全生效。'
      ], [
        h('button', {class: 'btn', onclick: (event) => busy(event.target, action('init-cert').then(() => toast('证书已初始化')).catch((error) => toast(error.message, true)))}, '初始化证书'),
        h('button', {class: 'btn primary', onclick: (event) => busy(event.target, action('trust-cert').then(() => toast('已请求信任证书；如弹出系统授权请确认')).catch((error) => toast(error.message, true)))}, '信任证书')
      ]);
    }

    if (snapshot.proxy?.restartRequired) {
      add('', '代理已写入，等待重启', [
        'Cursor 只在启动时读取 http.proxy。请完全退出并重新打开 Cursor（仅重载窗口通常不够）。'
      ], [
        h('button', {class: 'btn ghost', onclick: () => action('reload-window').catch((error) => toast(error.message, true))}, '重载窗口')
      ]);
    }

    if (snapshot.state === 'paused') {
      add('', '代理设置被外部改动', [
        snapshot.detail || '另一个程序改写了 Cursor 的 http.proxy。',
        '强制接管会以本插件为准重写代理设置。'
      ], [
        h('button', {class: 'btn primary', onclick: (event) => busy(event.target, action('force-start').then(() => toast('已重新接管代理')).catch((error) => toast(error.message, true)))}, '强制接管')
      ]);
    }

    if (snapshot.state === 'error') {
      add('bad', '桥接启动失败', [snapshot.detail || '请查看诊断与日志。'], [
        h('button', {class: 'btn', onclick: () => switchPage('diagnostics').then(() => runDiagnose())}, '运行诊断'),
        h('button', {class: 'btn', onclick: () => switchPage('logs').then(() => loadLogs())}, '查看日志')
      ]);
    }
  }

  function renderOverview() {
    const cards = $('#overviewCards');
    cards.replaceChildren();
    if (!snapshot) {
      cards.append(h('div', {class: 'empty', text: '正在读取桥接状态…'}));
      return;
    }
    const state = snapshot.state;
    const [stateText] = STATE[state] || [state];
    const stats = [
      ['桥接状态', stateText, snapshot.detail || '', 'small'],
      ['引擎代理', snapshot.engine?.running ? snapshot.engine.proxy : '未运行', snapshot.engine?.running ? `PID ${snapshot.engine.pid} · ${snapshot.engine.mode}` : '证书或配置未就绪', 'small'],
      ['模型', `${snapshot.catalogue?.count || 0}`, `默认：${snapshot.catalogue?.defaultModel || '未选择'}`, ''],
      ['提供者', `${snapshot.providers?.length || 0}`, (snapshot.providers || []).map((p) => p.name).join('、') || '尚未配置', ''],
      ['今日调用', `${snapshot.calls?.calls || 0}`, `错误 ${snapshot.calls?.errors || 0} · 平均 ${snapshot.calls?.averageMs || 0} ms`, ''],
      ['证书', snapshot.cert?.trusted ? '已信任' : '未信任', snapshot.cert?.detail || '', 'small'],
      ['数据库', fmtBytes(snapshot.db?.sizeBytes), snapshot.db?.driver || '不可用', 'small']
    ];
    for (const [label, value, sub, size] of stats) {
      cards.append(h('div', {class: 'card'},
        h('div', {class: 'card-label', text: label}),
        h('div', {class: `card-value ${size}`.trim(), text: value}),
        h('div', {class: 'card-sub', text: sub})
      ));
    }

    const onboarding = $('#onboardingPanel');
    const providers = snapshot.config?.providers || [];
    if (!providers.length) {
      onboarding.hidden = false;
      onboarding.replaceChildren(
        h('h2', {class: 'section-head'}, '开始使用'),
        h('p', {class: 'muted', text: 'Cursor Bridge 把 OpenAI 兼容的上游接入 Cursor。先添加一个上游提供者，然后启用桥接。'}),
        h('div', {class: 'list'},
          onboardingCard('导入 Magpie', '自动读取 Magpie → Agents 写入的本机连接，模型目录跟随 Magpie 实时更新。', '导入 Magpie', () =>
            busy($('#btnImportMagpie'), action('import-magpie').then((result) => { toast(`已导入 Magpie（${result.detected} 个模型）`); switchPage('providers'); }).catch((error) => toast(error.message, true)))),
          onboardingCard('接入 cc-switch（自动跟随）', '把 cc-switch 当前启用的供应商作为上游；在 cc-switch 里切换供应商，Cursor 侧自动跟随。', '接入 cc-switch', () => addCcSwitchProvider()),
          onboardingCard('从 cc-switch 导入', '读取 cc-switch 中已配置的 Claude Code 供应商；导入时自动探测它们的 OpenAI 兼容端点。', '导入 cc-switch', () => openCcSwitchModal()),
          onboardingCard('添加自定义 Base URL', '任意 OpenAI 兼容平台：OpenRouter、DeepSeek、自建网关等。密钥保存在 Cursor 的 SecretStorage。', '添加提供者', () => openProviderModal(null))
        )
      );
    } else {
      onboarding.hidden = true;
    }
  }

  function onboardingCard(title, text, buttonText, onClick) {
    return h('div', {class: 'item'},
      h('div', {class: 'item-head'},
        h('div', {},
          h('div', {class: 'item-title', text: title}),
          h('div', {class: 'item-meta', text: text})
        ),
        h('button', {class: 'btn primary', onclick: onClick}, buttonText)
      )
    );
  }

  // ---- providers ---------------------------------------------------------

  function renderProviders() {
    const list = $('#providerList');
    if (document.activeElement && list.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
    list.replaceChildren();
    const providers = snapshot?.config?.providers || [];
    if (!providers.length) {
      list.append(h('div', {class: 'empty', text: '尚未配置提供者。点击右上角「导入 Magpie」或「添加自定义」。'}));
      return;
    }
    const statusById = new Map((snapshot.providers || []).map((entry) => [entry.id, entry]));
    for (const provider of providers) {
      const live = statusById.get(provider.id);
      const tone = !provider.enabled ? '' : live?.error ? 'warn' : live ? 'ok' : '';
      const tagText = !provider.enabled ? '已停用' : live?.error ? '异常' : live ? '在线' : '待启动';
      const typeLabel = provider.type === 'magpie' ? 'Magpie' : provider.type === 'cc-switch' ? 'cc-switch' : '自定义';
      const protocolTag = provider.type === 'openai' && provider.protocol === 'anthropic'
        ? h('span', {class: 'tag', text: 'Anthropic'})
        : null;
      const source = provider.type === 'cc-switch'
        ? (live?.ccSwitchName
          ? `当前跟随：${live.ccSwitchName}${live.ccSwitchImplicit ? '（未标记当前项，使用第一个可用供应商）' : ''}`
          : '等待桥接启动后读取 cc-switch 当前供应商')
        : `${provider.baseUrl}${provider.autoDiscover ? ' · 自动发现' : ''}`;
      list.append(h('div', {class: 'item'},
        h('div', {class: 'item-head'},
          h('div', {},
            h('div', {class: 'item-title'}, provider.name, h('span', {class: `tag ${tone}`, text: tagText}), h('span', {class: 'tag', text: typeLabel}), protocolTag),
            h('div', {class: 'item-meta', text: source}),
            h('div', {class: 'item-meta', text: live ? `${live.models} 个模型${live.error ? ` · ${live.error}` : ''}` : '等待桥接启动后读取模型目录'})
          ),
          h('div', {class: 'item-actions'},
            provider.type === 'cc-switch' ? null : h('button', {class: 'btn', onclick: () => testProvider(provider)}, '测试'),
            h('button', {class: 'btn', onclick: () => openProviderModal(provider)}, '编辑'),
            h('button', {class: 'btn', onclick: (event) => busy(event.target, action('toggle-provider', {id: provider.id, enabled: !provider.enabled}).catch((error) => toast(error.message, true)))}, provider.enabled ? '停用' : '启用'),
            h('button', {class: 'btn danger', onclick: () => removeProvider(provider)}, '删除')
          )
        )
      ));
    }
  }

  function providerDraft(provider) {
    return provider || {
      id: '',
      type: 'openai',
      name: '',
      enabled: true,
      autoDiscover: false,
      protocol: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      headers: {},
      models: []
    };
  }

  function openProviderModal(provider) {
    modalState = {kind: 'provider', original: provider, isNew: !provider};
    const draft = providerDraft(provider);
    $('#modalTitle').textContent = provider ? `编辑 ${provider.name}` : '添加提供者';
    const body = $('#modalBody');
    body.replaceChildren();

    const type = h('select', {class: 'input select', id: 'fType'},
      h('option', {value: 'openai', selected: draft.type === 'openai'}, 'OpenAI 兼容（自定义 Base URL）'),
      h('option', {value: 'magpie', selected: draft.type === 'magpie'}, 'Magpie'),
      h('option', {value: 'cc-switch', selected: draft.type === 'cc-switch'}, 'cc-switch（自动跟随当前供应商）')
    );
    const id = h('input', {class: 'input', id: 'fId', value: draft.id, placeholder: 'openrouter', disabled: !!provider, autocomplete: 'off'});
    const name = h('input', {class: 'input', id: 'fName', value: draft.name, placeholder: 'OpenRouter', autocomplete: 'off'});
    const baseUrl = h('input', {class: 'input', id: 'fBaseUrl', value: draft.baseUrl, placeholder: 'https://api.openai.com/v1', autocomplete: 'off'});
    const autoDiscover = h('input', {type: 'checkbox', id: 'fAutoDiscover', checked: draft.autoDiscover});
    const key = h('input', {class: 'input', id: 'fKey', type: 'password', placeholder: provider ? '留空表示保留原密钥' : 'sk-…', autocomplete: 'off'});
    const clearKey = h('input', {type: 'checkbox', id: 'fClearKey'});
    const headers = h('textarea', {class: 'textarea', id: 'fHeaders', placeholder: '{"x-custom-header": "value"}'});
    headers.value = Object.keys(draft.headers || {}).length ? JSON.stringify(draft.headers, null, 2) : '';
    const models = h('textarea', {class: 'textarea', id: 'fModels', placeholder: 'model-a\nmodel-b'});
    models.value = (draft.models || []).join('\n');
    const testResult = h('div', {class: 'hint', id: 'fTestResult'});

    const protocol = h('select', {class: 'input select', id: 'fProtocol'},
      h('option', {value: 'openai', selected: draft.protocol !== 'anthropic'}, 'OpenAI 兼容（chat/completions）'),
      h('option', {value: 'anthropic', selected: draft.protocol === 'anthropic'}, 'Anthropic 兼容（messages）')
    );
    const protocolField = h('div', {class: 'field'}, h('label', {text: '上游协议'}), protocol,
      h('div', {class: 'hint', text: 'cc-switch 与 Claude Code 类网关使用 Anthropic 协议，插件会把它翻译成 Cursor 需要的 OpenAI 格式。'}));
    const baseUrlField = h('div', {class: 'field'}, h('label', {text: 'Base URL（OpenAI 兼容根地址，或 Anthropic 网关地址）'}), baseUrl);
    const autoField = h('div', {class: 'field'}, h('label', {class: 'check'}, autoDiscover, '自动读取 Magpie 连接（connection.json）'));
    const keyField = h('div', {class: 'field'}, h('label', {text: 'API Key（保存在 Cursor SecretStorage）'}), key);
    const clearField = provider
      ? h('div', {class: 'field'}, h('label', {class: 'check'}, clearKey, '清除已保存的密钥'))
      : null;
    const headersField = h('div', {class: 'field'}, h('label', {text: '自定义请求头（JSON，可选）'}), headers,
      h('div', {class: 'hint', text: '例如 {"HTTP-Referer": "https://example.com"}；Authorization 由插件根据密钥生成。'}));
    const modelsField = h('div', {class: 'field'}, h('label', {text: '指定模型列表（每行一个，可选）'}), models,
      h('div', {class: 'hint', text: '留空则启动时从 {Base URL}/models 拉取；拉取失败的平台可以手填。'}));
    const testField = h('div', {class: 'field'},
      h('button', {class: 'btn', onclick: (event) => {
        const provider = readProviderForm();
        if (!provider) return;
        busy(event.target, action('test-provider', {provider, key: key.value.trim()})
          .then((result) => { testResult.textContent = `连接成功：${result.count} 个模型，例如 ${result.sample.join('、') || '—'}`; })
          .catch((error) => { testResult.textContent = `连接失败：${error.message}`; }));
      }}, '测试连接'),
      testResult
    );
    const ccSwitchField = h('div', {class: 'field'},
      h('div', {class: 'hint', text: '上游地址与令牌来自 cc-switch 当前启用的供应商；在 cc-switch 里切换后，Cursor 侧会在下个刷新周期自动跟随。'}));

    const syncType = () => {
      const isMagpie = type.value === 'magpie';
      const isCcSwitch = type.value === 'cc-switch';
      autoField.hidden = !isMagpie;
      protocolField.hidden = isCcSwitch || isMagpie;
      for (const field of [baseUrlField, keyField, clearField, headersField, modelsField, testField].filter(Boolean)) {
        field.hidden = isCcSwitch;
      }
      ccSwitchField.hidden = !isCcSwitch;
      baseUrl.disabled = isMagpie;
      if (isMagpie) {
        autoDiscover.checked = true;
        baseUrl.value = 'http://127.0.0.1:3425/v1';
      }
    };
    type.addEventListener('change', syncType);
    autoDiscover.addEventListener('change', syncType);
    name.addEventListener('input', () => {
      if (modalState?.isNew && !id.value) {
        id.value = slug(name.value);
      }
    });

    body.append(
      h('div', {class: 'field'}, h('label', {text: '类型'}), type),
      protocolField,
      h('div', {class: 'field-row'},
        h('div', {class: 'field'}, h('label', {text: 'ID（模型前缀，必须唯一）'}), id),
        h('div', {class: 'field'}, h('label', {text: '显示名称'}), name)
      ),
      ccSwitchField,
      baseUrlField,
      autoField,
      keyField,
      clearField,
      headersField,
      modelsField,
      testField
    );
    syncType();
    showModal();
  }

  function slug(value) {
    return String(value || '').toLowerCase().trim()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'provider';
  }

  function readProviderForm() {
    const type = $('#fType').value;
    const id = $('#fId').value.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) {
      toast('ID 只能包含小写字母、数字、- 和 _，且以字母或数字开头', true);
      return null;
    }
    const name = $('#fName').value.trim() || id;
    if (type === 'cc-switch') {
      // The live provider carries no URL, key or model list of its own: all of
      // it is resolved from cc-switch on every refresh.
      return {
        id,
        type,
        name,
        enabled: modalState?.original?.enabled !== false,
        autoDiscover: true,
        baseUrl: '',
        headers: {},
        models: []
      };
    }
    let headers = {};
    const headerText = $('#fHeaders').value.trim();
    if (headerText) {
      try {
        headers = JSON.parse(headerText);
        if (!headers || typeof headers !== 'object' || Array.isArray(headers)) throw new Error('必须是 JSON 对象');
      } catch (error) {
        toast(`请求头格式错误：${error.message}`, true);
        return null;
      }
    }
    return {
      id,
      type,
      name,
      enabled: modalState?.original?.enabled !== false,
      autoDiscover: type === 'magpie' && $('#fAutoDiscover').checked,
      protocol: $('#fProtocol').value === 'anthropic' ? 'anthropic' : 'openai',
      baseUrl: $('#fBaseUrl').value.trim(),
      headers,
      models: $('#fModels').value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    };
  }

  async function saveProvider() {
    const provider = readProviderForm();
    if (!provider) return;
    const key = $('#fKey').value;
    const clearKey = $('#fClearKey')?.checked;
    await action('save-provider', {provider, key, clearKey});
    hideModal();
    toast(`已保存 ${provider.name}`);
  }

  async function removeProvider(provider) {
    const ok = await confirmDialog({
      title: `删除 ${provider.name}`,
      message: '将同时删除保存在 SecretStorage 中的密钥。正在使用该提供者的模型会从 Cursor 菜单消失。',
      confirmText: '删除'
    });
    if (!ok) return;
    await action('delete-provider', {id: provider.id});
    toast('提供者已删除');
  }

  function testProvider(provider) {
    return action('test-provider', {provider})
      .then((result) => toast(`连接成功：${result.count} 个模型`))
      .catch((error) => toast(`连接失败：${error.message}`, true));
  }

  async function addCcSwitchProvider() {
    const result = await action('add-cc-switch-provider').catch((error) => { toast(error.message, true); return null; });
    if (!result) return;
    const suffix = result.current?.implicit ? '（未标记当前供应商，使用第一个可用项）' : '';
    toast(`${result.existing ? '已在跟随' : '已接入'} cc-switch：${result.current?.name || ''}${suffix}`);
    switchPage('providers');
  }

  // ---- cc-switch import --------------------------------------------------

  async function openCcSwitchModal() {
    const data = await action('scan-cc-switch').catch((error) => { toast(error.message, true); return null; });
    if (!data) return;
    if (data.error) { toast(data.error, true); return; }
    if (!data.providers.length) { toast('cc-switch 中没有可导入的供应商', true); return; }

    modalState = {kind: 'ccswitch', providers: data.providers, selected: new Set()};
    $('#modalTitle').textContent = `导入 cc-switch（${data.providers.length}）`;
    const body = $('#modalBody');
    body.replaceChildren();

    const rows = [];
    const list = h('div', {class: 'cc-list'});
    for (const provider of data.providers) {
      const checkbox = h('input', {type: 'checkbox'});
      const meta = [
        provider.appType,
        provider.isCurrent ? '当前使用' : '',
        provider.hasToken ? '有令牌' : '无令牌'
      ].filter(Boolean).join(' · ');
      const row = h('label', {class: 'cc-row'},
        checkbox,
        h('div', {class: 'grow'},
          h('div', {class: 'model-name', text: provider.name}),
          h('div', {class: 'model-id', text: provider.baseUrl}),
          h('div', {class: 'hint', text: meta})
        )
      );
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) modalState?.selected.add(provider.key);
        else modalState?.selected.delete(provider.key);
        updateImportButton();
      });
      rows.push({provider, row});
      list.append(row);
    }

    const search = h('input', {class: 'input', placeholder: '搜索名称或地址…'});
    search.addEventListener('input', () => {
      const query = search.value.trim().toLowerCase();
      for (const entry of rows) {
        entry.row.hidden = !!query && !`${entry.provider.name} ${entry.provider.baseUrl}`.toLowerCase().includes(query);
      }
    });

    body.append(
      h('div', {class: 'hint', text: `来源：${data.source}。cc-switch 保存的是 Anthropic 端点，导入时会自动探测同一网关的 OpenAI 兼容地址；探测失败的条目仍会导入，可在提供者页手动修正。`}),
      h('div', {class: 'field'}, search),
      list
    );
    updateImportButton();
    showModal();
  }

  function updateImportButton() {
    const count = modalState?.selected?.size || 0;
    $('#modalSave').textContent = count ? `导入所选（${count}）` : '导入所选';
  }

  async function importCcSwitch() {
    const keys = [...(modalState?.selected || [])];
    if (!keys.length) { toast('请至少选择一个供应商', true); return; }
    const save = $('#modalSave');
    save.disabled = true;
    save.textContent = '导入中…';
    try {
      const result = await action('import-cc-switch', {keys}, {timeout: 300000});
      const imported = result.imported || [];
      const failed = result.failed || [];
      const anthropicCount = imported.filter((entry) => entry.protocol === 'anthropic').length;
      hideModal();
      const parts = [`已导入 ${imported.length} 个`];
      if (anthropicCount) parts.push(`${anthropicCount} 个按 Anthropic 协议接入`);
      if (failed.length) {
        parts.push(`失败 ${failed.length} 个`);
        toast(`${parts.join('，')}。${failed[0].name}：${failed[0].error}`, true);
      } else {
        toast(parts.join('，'));
      }
    } finally {
      save.disabled = false;
      $('#modalSave').textContent = '导入所选';
    }
  }

  // ---- models ------------------------------------------------------------

  function renderModels() {
    const root = $('#modelGroups');
    if (document.activeElement && root.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
    root.replaceChildren();
    const groups = snapshot?.catalogue?.groups || [];
    $('#modelSummary').textContent = snapshot?.catalogue
      ? `${snapshot.catalogue.count} 个模型 · 默认 ${snapshot.catalogue.defaultModel || '未选择'}`
      : '';
    if (!groups.length) {
      root.append(h('div', {class: 'empty', text: '桥接运行并拉到模型后，这里会显示可重命名、隐藏和排序的模型列表。'}));
      return;
    }
    for (const group of groups) {
      const prefs = snapshot.config?.modelPrefs?.[group.providerId] || {names: {}, hidden: [], order: []};
      const head = h('div', {class: 'item-head'},
        h('div', {},
          h('div', {class: 'item-title', text: group.providerName}),
          h('div', {class: 'item-meta', text: `${group.models.length} 个模型${group.error ? ` · ${group.error}` : ''}`})
        )
      );
      const rows = group.models.map((model, index) => {
        const isDefault = snapshot.catalogue?.defaultModel === model.id;
        const hiddenModel = (prefs.hidden || []).includes(model.upstreamId);
        const nameInput = h('input', {
          class: 'input',
          type: 'text',
          value: prefs.names?.[model.upstreamId] || model.name,
          onchange: (event) => saveModelPrefs(group.providerId, {
            ...currentPrefs(group.providerId),
            names: {...currentPrefs(group.providerId).names, [model.upstreamId]: event.target.value.trim()}
          })
        });
        return h('div', {class: `model-row${hiddenModel ? ' hidden' : ''}`},
          h('div', {class: 'grow'},
            nameInput,
            h('div', {class: 'model-id', text: model.upstreamId + (model.context ? ` · ${Math.round(model.context / 1000)}k 上下文` : '')})
          ),
          h('button', {class: 'btn ghost', onclick: () => action('select-model', {id: model.id}).then(() => toast('默认模型已更新')).catch((error) => toast(error.message, true))}, isDefault ? '默认 ✓' : '设为默认'),
          h('button', {class: 'btn ghost', onclick: () => toggleHidden(group.providerId, model.upstreamId, hiddenModel)}, hiddenModel ? '显示' : '隐藏'),
          h('button', {class: 'btn ghost', disabled: index === 0, onclick: () => moveModel(group, index, -1)}, '↑'),
          h('button', {class: 'btn ghost', disabled: index === group.models.length - 1, onclick: () => moveModel(group, index, 1)}, '↓')
        );
      });
      root.append(h('div', {class: 'item'}, head, ...rows));
    }
  }

  function currentPrefs(providerId) {
    return snapshot?.config?.modelPrefs?.[providerId] || {names: {}, hidden: [], order: []};
  }

  function saveModelPrefs(providerId, prefs) {
    return action('set-model-prefs', {providerId, prefs}).catch((error) => toast(error.message, true));
  }

  function toggleHidden(providerId, upstreamId, hidden) {
    const prefs = currentPrefs(providerId);
    const next = new Set(prefs.hidden || []);
    if (hidden) next.delete(upstreamId); else next.add(upstreamId);
    saveModelPrefs(providerId, {...prefs, hidden: [...next]});
  }

  function moveModel(group, index, direction) {
    const ids = group.models.map((model) => model.upstreamId);
    const target = index + direction;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    saveModelPrefs(group.providerId, {...currentPrefs(group.providerId), order: ids});
  }

  // ---- calls -------------------------------------------------------------

  async function loadCalls(reset) {
    if (reset) { callsRows = []; callsOffset = 0; }
    const data = await action('calls', {limit: 100, offset: callsOffset})
      .catch((error) => { toast(error.message, true); return null; });
    if (!data) return;
    callsRows = callsRows.concat(data.rows || []);
    callsOffset = callsRows.length;
    renderCallSummary(data.summary);
    renderCallTable();
  }

  function renderCallSummary(summary) {
    const root = $('#callSummary');
    const data = summary || snapshot?.calls || {};
    root.replaceChildren(
      metric('今日调用', fmtNumber(data.calls)),
      metric('错误', fmtNumber(data.errors)),
      metric('平均耗时', `${data.averageMs || 0} ms`),
      metric('Tokens', fmtNumber(data.tokens))
    );
  }

  function metric(label, value) {
    return h('div', {class: 'card'},
      h('div', {class: 'card-label', text: label}),
      h('div', {class: 'card-value small', text: value})
    );
  }

  function renderCallTable() {
    const body = $('#callTable tbody');
    body.replaceChildren();
    if (!callsRows.length) {
      body.append(h('tr', {}, h('td', {colspan: 8, class: 'muted', text: '暂无调用记录。'}) ));
      return;
    }
    for (const row of callsRows) {
      const tone = row.error || row.status >= 400 ? 'status-bad' : 'status-ok';
      body.append(h('tr', {},
        h('td', {text: fmtTime(row.ts)}),
        h('td', {text: row.providerName || row.providerId}),
        h('td', {class: 'wrap', text: row.upstreamModel || row.model}),
        h('td', {class: tone, text: String(row.status || (row.error ? 'ERR' : '—'))}),
        h('td', {text: `${row.durationMs || 0} ms`}),
        h('td', {text: row.ttfbMs == null ? '—' : `${row.ttfbMs} ms`}),
        h('td', {text: `${row.inputTokens || 0} / ${row.outputTokens || 0}`}),
        h('td', {class: 'wrap', text: row.error || ''})
      ));
    }
  }

  // ---- database ----------------------------------------------------------

  async function loadDatabase(deep) {
    const data = await action('db-stats', {deep}).catch((error) => { toast(error.message, true); return null; });
    if (!data) return;
    dbView = data;
    renderDatabase();
  }

  function renderDatabase() {
    const body = $('#dbTable tbody');
    body.replaceChildren();
    if (!dbView) {
      $('#dbMeta').textContent = '点击「统计」读取引擎数据库分类。深度统计会读取所有内容字节，较大的库需要更久。';
      return;
    }
    if (!dbView.ok) {
      $('#dbMeta').textContent = dbView.error || dbView.detail || '数据库不可用';
      return;
    }
    $('#dbMeta').textContent = `${dbView.file} · ${fmtBytes(dbView.sizeBytes)} · 驱动 ${dbView.driver}${dbView.deep ? ' · 深度统计' : ''}`;
    for (const table of dbView.tables || []) {
      body.append(h('tr', {},
        h('td', {text: table.category}),
        h('td', {text: `${table.label} (${table.name})`}),
        h('td', {text: table.rows == null ? '—' : fmtNumber(table.rows)}),
        h('td', {text: table.bytes == null ? '—' : fmtBytes(table.bytes)})
      ));
    }
  }

  async function pruneDatabase() {
    const days = snapshot?.runtime?.tracesRetentionDays || 30;
    const ok = await confirmDialog({
      title: '清理旧请求链路',
      message: `将删除 ${days} 天前的 cursor_run_traces 记录，删除前会备份数据库到扩展存储。会话与消息不会删除。`,
      confirmText: '清理'
    });
    if (!ok) return;
    const result = await action('db-prune', {days}).catch((error) => { toast(error.message, true); return null; });
    if (result) toast(`已删除 ${result.removed || 0} 行`);
    loadDatabase(false);
  }

  async function vacuumDatabase() {
    const ok = await confirmDialog({
      title: '压缩数据库',
      message: 'VACUUM 会重建数据库文件，期间引擎会短暂停止。执行前会自动备份。大库可能需要数十秒。',
      confirmText: '执行 VACUUM'
    });
    if (!ok) return;
    toast('正在 VACUUM…');
    const result = await action('db-vacuum').catch((error) => { toast(error.message, true); return null; });
    if (result) toast(result.ok ? `已回收 ${fmtBytes(result.saved)}` : `VACUUM 失败：${result.error}`, !result.ok);
    loadDatabase(false);
  }

  // ---- diagnostics -------------------------------------------------------

  async function runDiagnose() {
    const data = await action('diagnose').catch((error) => { toast(error.message, true); return null; });
    if (!data) return;
    diagnosticsView = data;
    renderDiagnostics();
  }

  const LAYER_NAMES = {service: '服务与进程', certificate: '证书', proxy: '代理', upstream: '上游', catalogue: '模型目录', database: '数据库'};

  function renderDiagnostics() {
    const root = $('#diagnosticList');
    root.replaceChildren();
    if (!diagnosticsView) {
      root.append(h('div', {class: 'empty', text: '点击「运行诊断」按层检查服务、证书、代理、上游与模型。'}));
      return;
    }
    const layers = new Map();
    for (const item of diagnosticsView.layers || []) {
      if (!layers.has(item.layer)) layers.set(item.layer, []);
      layers.get(item.layer).push(item);
    }
    for (const [layer, items] of layers) {
      root.append(h('div', {class: 'layer-title', text: LAYER_NAMES[layer] || layer}));
      for (const item of items) {
        root.append(h('div', {class: 'diag'},
          h('div', {class: `diag-icon ${item.status}`, text: item.status === 'ok' ? '✓' : item.status === 'warn' ? '!' : '×'}),
          h('div', {class: 'diag-body'},
            h('div', {class: 'diag-name', text: item.name}),
            h('div', {class: 'diag-detail', text: item.detail}),
            item.hint ? h('div', {class: 'diag-hint', text: item.hint}) : null
          )
        ));
      }
    }
  }

  // ---- logs --------------------------------------------------------------

  async function loadLogs() {
    const source = $('#logSource').value;
    const data = await action('logs', {source, lines: 400}).catch((error) => { toast(error.message, true); return null; });
    if (!data) return;
    $('#logText').textContent = data.text || '（日志为空）';
    $('#logText').scrollTop = $('#logText').scrollHeight;
  }

  // ---- modal and confirm -------------------------------------------------

  function showModal() {
    $('#modal').hidden = false;
  }

  function hideModal() {
    $('#modal').hidden = true;
    modalState = null;
  }

  function confirmDialog({title, message, confirmText = '确认'}) {
    return new Promise((resolve) => {
      modalState = {kind: 'confirm', resolve};
      $('#modalTitle').textContent = title;
      $('#modalBody').replaceChildren(h('div', {class: 'muted', text: message}));
      $('#modalSave').textContent = confirmText;
      showModal();
    });
  }

  // ---- navigation and wiring --------------------------------------------

  const PAGE_RENDERERS = {
    overview: renderOverview,
    providers: renderProviders,
    models: renderModels,
    calls: () => { renderCallSummary(); renderCallTable(); },
    database: renderDatabase,
    diagnostics: renderDiagnostics,
    logs: () => {}
  };

  function switchPage(page) {
    currentPage = page;
    for (const button of document.querySelectorAll('.nav-item')) {
      button.classList.toggle('active', button.dataset.page === page);
    }
    for (const section of document.querySelectorAll('.page')) {
      section.classList.toggle('active', section.id === `page-${page}`);
    }
    PAGE_RENDERERS[page]?.();
    return Promise.resolve();
  }

  function wire() {
    for (const button of document.querySelectorAll('.nav-item')) {
      button.addEventListener('click', () => switchPage(button.dataset.page));
    }

    $('#btnStart').addEventListener('click', (event) => busy(event.target, action('start')
      .then(() => { toast('桥接已启用'); populateFromStatus(); })
      .catch((error) => toast(error.message, true))));
    $('#btnStop').addEventListener('click', async (event) => {
      const ok = await confirmDialog({title: '停止并还原代理', message: '将停止引擎并还原 Cursor 的 http.proxy。之后需要重启 Cursor 才能完全恢复网络设置。', confirmText: '停止'});
      if (!ok) return;
      busy(event.target, action('stop').then(() => toast('已停止，代理已还原。请重启 Cursor。')).catch((error) => toast(error.message, true)));
    });
    $('#btnRestart').addEventListener('click', (event) => busy(event.target, action('restart')
      .then(() => toast('桥接已重启'))
      .catch((error) => toast(error.message, true))));
    $('#btnReload').addEventListener('click', () => action('reload-window').catch((error) => toast(error.message, true)));
    $('#btnImportMagpie').addEventListener('click', (event) => busy(event.target, action('import-magpie')
      .then((result) => { toast(`已导入 Magpie（${result.detected} 个模型）`); switchPage('providers'); })
      .catch((error) => toast(error.message, true))));
    $('#btnAddProvider').addEventListener('click', () => openProviderModal(null));
    $('#btnImportCcSwitch').addEventListener('click', () => openCcSwitchModal());
    $('#btnAddCcSwitch').addEventListener('click', () => addCcSwitchProvider());
    $('#btnRefreshCalls').addEventListener('click', () => loadCalls(true));
    $('#btnMoreCalls').addEventListener('click', () => loadCalls(false));
    $('#btnDbStats').addEventListener('click', () => loadDatabase(false));
    $('#btnDbDeep').addEventListener('click', () => loadDatabase(true));
    $('#btnDbPrune').addEventListener('click', () => pruneDatabase());
    $('#btnDbVacuum').addEventListener('click', () => vacuumDatabase());
    $('#btnDiagnose').addEventListener('click', () => runDiagnose());
    $('#btnLogs').addEventListener('click', () => loadLogs());
    $('#btnCopyLogs').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText($('#logText').textContent); toast('日志已复制'); }
      catch { toast('复制失败', true); }
    });

    $('#modalClose').addEventListener('click', () => closeModal(false));
    $('#modalCancel').addEventListener('click', () => closeModal(false));
    $('#modalBackdrop').addEventListener('click', () => closeModal(false));
    $('#modalSave').addEventListener('click', async () => {
      if (modalState?.kind === 'confirm') {
        const resolve = modalState.resolve;
        hideModal();
        resolve(true);
        return;
      }
      if (modalState?.kind === 'ccswitch') {
        try { await importCcSwitch(); } catch (error) { toast(error.message, true); }
        return;
      }
      try {
        await saveProvider();
      } catch (error) {
        toast(error.message, true);
      }
    });
  }

  function closeModal(value) {
    if (modalState?.kind === 'confirm') {
      const resolve = modalState.resolve;
      hideModal();
      resolve(value);
      return;
    }
    hideModal();
  }

  function populateFromStatus() {
    action('refresh').then((state) => { snapshot = state; renderAll(); }).catch(() => {});
  }

  wire();
  switchPage('overview');
  populateFromStatus();
}());