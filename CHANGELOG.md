# 变更记录

## 0.1.0（2026-11-20）

首个 VSIX 版本。

### 新增

- 标准 VS Code 扩展形态，通过 VSIX 安装到 Cursor，不修改 Cursor 安装包
- 后台服务与窗口解耦：关窗保持接管，重新打开秒级恢复
- 提供者抽象：
  - Magpie 自动发现（读取 `connection.json`，模型目录每 15 秒同步）
  - 任意 OpenAI 兼容 Base URL，密钥保存在 SecretStorage
  - 多提供者聚合，模型 ID 以 `<提供者>/<模型>` 前缀路由
- 本地 OpenAI 中继：把远程 Base URL 适配为原生引擎唯一接受的 loopback 网关
- Webview 控制台：
  - 概览、提供者、模型、调用、数据库、诊断、日志
  - 模型重命名 / 隐藏 / 排序 / 设为默认
  - 分层自检与冲突提示
- 证书管理：初始化本地 CA，macOS 钥匙串 / Windows 本机根存储 / Linux argv.json + NSS 信任
- 代理接管：JSONC 安全写入、journal 备份与还原、外部改动检测
- 调用日志：按天 JSONL，记录耗时、TTFB、tokens、错误
- 引擎数据库：分类统计、清理旧链路、VACUUM（自动备份）
- 旧版 Magpie 桥接冲突检测
- 应急还原脚本（`~/.cursor-bridge`）
- 全平台打包：darwin-arm64、darwin-x64、win32-x64、linux-x64、linux-arm64