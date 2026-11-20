# Cursor Bridge（VSIX）

在 Cursor 中直接使用 **Magpie** 或**任意 OpenAI 兼容平台**作为上游模型。

- **形态**：标准 VS Code 扩展，通过 VSIX 安装到 Cursor，不修改 Cursor 安装包、不打补丁
- **上游**：内置 Magpie 提供者（自动跟随 `connection.json`），同时支持任意自定义 Base URL
- **聚合**：多个提供者的模型同时出现在 Cursor 模型菜单，模型 ID 以 `<提供者>/<模型>` 前缀路由
- **平台**：macOS（arm64 / x64）、Windows x64、Linux x64 / arm64
- **当前版本**：`0.1.0`

---

## 一、它解决什么问题

Cursor 的 Agent / Composer 默认只认自家后端。已有的 Magpie 桥接通过「后台服务 + 修改 Cursor 源码/代理」工作，安装链路长、升级容易断。

Cursor Bridge 换了一种分层方式：

- **扩展负责控制**：配置、状态、Webview 控制台、证书与代理生命周期
- **后台服务负责运行**：脱离窗口常驻，管理本地中继与原生引擎
- **原生引擎负责协议**：把 Cursor 的私有协议翻译成 OpenAI Chat Completions
- **本地中继负责适配**：把 Magpie / 任意远程 Base URL 统一成引擎唯一接受的 loopback 网关

因此：

- 装一个 VSIX 就能用，不需要 `setup.command`、LaunchAgent、systemd
- Magpie 只是「提供者」之一，不装 Magpie 也能接其他平台
- 多平台可以同时配置，模型菜单自动聚合

---

## 二、安装

1. 从 Release 下载与平台对应的 VSIX：

   | 平台 | 文件 |
   |---|---|
   | macOS Apple Silicon | `cursor-bridge-0.1.0-darwin-arm64.vsix` |
   | macOS Intel | `cursor-bridge-0.1.0-darwin-x64.vsix` |
   | Windows x64 | `cursor-bridge-0.1.0-win32-x64.vsix` |
   | Linux x64 | `cursor-bridge-0.1.0-linux-x64.vsix` |
   | Linux arm64 | `cursor-bridge-0.1.0-linux-arm64.vsix` |

2. Cursor → 命令面板 → `Extensions: Install from VSIX...` → 选择文件
3. 完全退出并重新打开 Cursor（让扩展与证书设置生效）
4. 命令面板运行 `Cursor Bridge: 打开桥接控制台`

---

## 三、首次配置

### 3.1 添加上游

控制台 → **提供者**：

- **导入 Magpie**：读取 Magpie → Agents 页面写入的 `connection.json`。之后在 Magpie 里切换模型、修改目录，Cursor 侧每 15 秒跟随更新。
- **添加自定义**：填写 OpenAI 兼容 Base URL 与 API Key。例如：

  | 平台 | Base URL 示例 |
  |---|---|
  | OpenRouter | `https://openrouter.ai/api/v1` |
  | DeepSeek | `https://api.deepseek.com/v1` |
  | 自建 one-api / new-api | `https://your-gateway/v1` |
  | 本地 Ollama（OpenAI 兼容层） | `http://127.0.0.1:11434/v1` |

  API Key 保存在 Cursor 的 SecretStorage，不写入磁盘明文配置。

### 3.2 信任证书

原生引擎用本地 CA 终止 TLS。首次启用前必须让 Cursor 信任它：

1. 概览页 → 「初始化证书」
2. 「信任证书」
   - macOS：钥匙串授权（登录密码）
   - Windows：管理员确认窗口（UAC）
   - Linux：写入 Cursor `argv.json`，有 `certutil` 时同时导入 NSS

证书未受信任时，插件**不会**写入代理，避免 Cursor 直接断网。

### 3.3 启用

1. 点击右上角「启用」
2. 桥接写入 `http.proxy` 后提示「待重启」
3. 完全退出并重新打开 Cursor
4. 状态变为「已连接」，Cursor 模型菜单出现聚合后的模型

> 仅 Reload Window 通常不足以让 Cursor 重新读取 `http.proxy`，请完整退出应用。

---

## 四、工作原理

```text
┌──────────────────────────────────────────────────────────────┐
│ Cursor 窗口                                                   │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ cursor-bridge VSIX（Extension Host）                    │  │
│  │  ├─ 命令 / 状态栏 / Webview 控制台                       │  │
│  │  ├─ SecretStorage 密钥                                   │  │
│  │  └─ 控制通道（127.0.0.1，随机端口 + token）              │  │
│  └───────────────────────────┬────────────────────────────┘  │
└──────────────────────────────┼───────────────────────────────┘
                               │ HTTP 控制
┌──────────────────────────────▼───────────────────────────────┐
│ 后台服务（detached，窗口关闭不影响）                          │
│  ├─ 提供者注册表：Magpie / 自定义 Base URL                    │
│  ├─ 本地中继（OpenAI 兼容，127.0.0.1）                        │
│  ├─ 代理接管 journal（写入 / 还原 Cursor settings.json）      │
│  ├─ 调用日志（JSONL，按天）                                   │
│  └─ spawn 原生引擎                                            │
│         │                                                     │
│  ┌──────▼─────────────────────────────────────────────────┐  │
│  │ 原生引擎（Rust）：MITM TLS 代理 127.0.0.1:58160         │  │
│  │  Cursor protobuf ↔ OpenAI Chat Completions              │  │
│  └──────┬─────────────────────────────────────────────────┘  │
└─────────┼────────────────────────────────────────────────────┘
          │ http://127.0.0.1:<中继端口>/v1
   ┌──────▼───────────────────────────┐
   │ 中继 → 当前启用的上游提供者         │
   │  · Magpie（本机网关）              │
   │  · 任意 OpenAI 兼容远程平台         │
   └──────────────────────────────────┘
```

**为什么要有本地中继**：原生引擎只会把请求发往 loopback 网关。中继把「任意远程 Base URL」适配成 loopback，同时成为提供者的统一接口——Magpie 与自定义平台走同一条路径。

**模型 ID 路由**：Cursor 看到的模型 ID 是 `<提供者ID>/<上游模型ID>`。中继按第一个 `/` 解析提供者，去掉前缀后转发。上游模型 ID 自身带 `/`（如 `anthropic/claude-...`）不受影响。

---

## 五、功能

| 能力 | 状态 |
|---|---|
| Magpie 自动发现与模型实时同步 | ✅ |
| 任意 OpenAI 兼容 Base URL | ✅ |
| 多提供者模型聚合 | ✅ |
| 模型重命名 / 隐藏 / 排序 / 设为默认 | ✅ |
| 调用日志：耗时、TTFB、tokens、错误 | ✅ |
| 引擎数据库分类统计、清理旧链路、VACUUM | ✅ |
| 分层自检（服务 / 证书 / 代理 / 上游 / 模型 / 数据库） | ✅ |
| 旧版 Magpie 桥接冲突检测 | ✅ |
| 关窗保持接管，重新打开秒级恢复 | ✅ |
| 应急还原脚本（扩展被禁用时断网的自救） | ✅ |
| Cursor Tab 补全 | 沿用 Cursor 原路径 |

---

## 六、生命周期与救援

### 6.1 关窗后保持接管

后台服务独立于窗口运行。关闭 Cursor 不会还原代理；下次启动时扩展在数秒内重新连上服务，引擎沿用固定端口，无需再次重启。

### 6.2 应急还原

首次写入代理前会备份 `settings.json`，并生成救援脚本：

- macOS / Linux：`~/.cursor-bridge/restore.command` 或 `restore.sh`
- Windows：`~/.cursor-bridge/restore.ps1`

如果扩展被禁用/卸载导致 Cursor 断网，运行对应脚本即可恢复原设置（脚本不依赖 Node 或本插件）。

### 6.3 卸载

1. 控制台 → 「停止并还原」
2. 完全退出并重新打开 Cursor
3. 卸载扩展

---

## 七、与旧版 Magpie 桥接共存

旧版（`magpie-agent-cursor-bridge`）通过 LaunchAgent / 启动项常驻并改写代理。**两者不能同时接管代理**。本插件启动时会检测：

- `~/.config/magpie-cursor-bridge/settings-journal.json`
- macOS `launchctl` 中的 `local.magpie.cursor-bridge`
- Linux systemd 用户单元
- Windows 启动文件夹脚本

检测到冲突时状态显示「冲突」并给出停止命令。停掉旧后台后点击「强制接管」或重启 Cursor 即可。

---

## 八、常见问题

**Q：启用后 Cursor 提示网络错误？**
A：按顺序检查：证书是否已信任 → 是否已完全重启 Cursor（不是 Reload Window）→ 诊断页「代理接管」「证书信任」两层是否都通过。

**Q：模型菜单是空的？**
A：至少启用一个提供者，且它返回了模型列表。Magpie 自动发现需要 Magpie → Agents 页面处于连接状态；自定义平台可在编辑框里手填模型列表兜底。

**Q：Magpie 里换了模型，Cursor 没变化？**
A：自动发现每 15 秒刷新一次（`cursorBridge.refreshSeconds`）。也可以在控制台点「重启」。

**Q：想接多个平台？**
A：直接添加多个提供者，全部启用后模型会聚合显示。模型 ID 冲突通过提供者前缀天然隔离。

**Q：数据库页显示不可用？**
A：它依赖 Node 内置的 `node:sqlite`（Cursor 3.x 自带的 Node 24 已支持）。调用日志不依赖数据库，仍可在「调用」页查看。

**Q：端口 58160 被占用？**
A：在设置里修改 `cursorBridge.proxyPort`，重启桥接后生效。Cursor 会自动读取新端口；如果已有代理设置，需要重新启用一次。

---

## 九、开发

```bash
# 单元测试（Node 24）
npm test

# 打包当前平台
npm run package:host

# 打包全部平台（输出到 dist/）
npm run package:all
```

目录结构：

```text
extension.js          扩展入口（激活、命令、状态栏）
src/service.js        后台服务：状态机 + 控制面
src/shim.js           本地 OpenAI 中继
src/engine.js         原生引擎进程管理
src/catalogue.js      模型聚合与 ID 路由
src/providers.js      Magpie / 自定义提供者
src/certificates.js   CA 初始化与信任
src/database.js       引擎数据库统计/清理
lib/                  JSONC 安全写入、跨平台路径
media/                控制台 Webview
resources/bin/        各平台原生引擎
vendor/jsonc-parser   保留注释的 JSONC 编辑
```

---

## 十、致谢与免责声明

- 原生引擎来自 [leookun/cursor-byok](https://github.com/leookun/cursor-byok)（MIT），协议适配来自 [nodlles/magpie-agent-cursor-bridge](https://github.com/nodlles/magpie-agent-cursor-bridge)
- 本项目只使用你自己配置的上游密钥，不上传、不复制任何平台凭据
- Cursor 的私有协议可能随版本变化；升级 Cursor 后如果桥接失效，请先查看诊断页与 Release Notes
- 仅用于个人在自有账号、自有密钥下的开发用途，请遵守 Cursor 与各模型提供商的服务条款

MIT License.