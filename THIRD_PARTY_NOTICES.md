# 第三方组件

## cursor-byok 原生引擎

- 来源：https://github.com/leookun/cursor-byok
- 许可：MIT
- 用途：Cursor 私有协议与 OpenAI Chat Completions 之间的本地转译、TLS 代理。
- 说明：`resources/bin/<platform>/cursor-magpie-bridge` 为预编译二进制，随本扩展分发。

## magpie-agent-cursor-bridge

- 来源：https://github.com/nodlles/magpie-agent-cursor-bridge
- 许可：MIT
- 用途：代理 journal、跨平台路径与协议适配的参考实现。

## jsonc-parser

- 来源：https://github.com/microsoft/node-jsonc-parser
- 许可：MIT
- 用途：保留注释地编辑 Cursor 的 `settings.json` 与 `argv.json`。

## Magpie

- 来源：https://github.com/yetone/magpie
- 许可：见上游仓库
- 说明：本扩展不包含 Magpie 本体，只读取其 Agents 页面写入的本机连接信息。