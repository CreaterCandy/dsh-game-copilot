# dsh-game-copilot 插件

本目录是项目的 DSH / Cordis 插件本体，符合标准 `name / inject / apply` 约定。它提供 HTTP 路由、模型能力路由、设置页后端，并管理透明桌宠小窗进程。

## 安装

普通用户请直接用仓库根目录的 `setup.ps1`，它会把整个 `plugin/` 目录复制到：

```
%DSH_HOME%\profiles\desktop\node_modules\dsh-game-copilot
```

已存在的配置不会被覆盖。开发调试时可以手动复制，然后重启 DSH 让插件重新加载。

## 职责

| 位置 | 作用 |
|---|---|
| `index.js` / `client.js` | 插件入口与前端注入；设置页以 iframe 形式挂在 DSH 设置里 |
| `src/host/plugin.mjs` | HTTP 路由：`/state`、`/ask`、`/settings`、`/logs`、`/overlay`、`/tts/probe` 等 |
| `src/host/http-llm.mjs` | 自定义 OpenAI 兼容端点与随机数字图探针 |
| `src/host/ask-route.mjs` | 一步式 / 两步式 / 盲答的纯函数判定 |
| `src/host/advise.mjs` | 按键问答的模型路由与回答编排 |
| `src/host/collect.mjs` | 截图与前台窗口识别（走项目自带 Win32/PowerShell 辅助脚本） |
| `runtime/overlay/` | Electron 透明置顶小窗：气泡、动画与拖拽 |

## 配置

设置页改的是 `%DSH_HOME%\dsh-game-copilot.json`，字段说明在仓库根目录 `README.md` 与 `docs/设计说明.md`。插件不保存 API Key 到仓库，密钥只在本机配置文件里。

## 素材与许可

代码为 MIT，上游基础来自 `bigk5780/dsh`，原声明见 `LICENSE`。`assets/webm/` 的 10 段动画来自 `PC2005-cloud/dsh-pet`，上游注明开源可用、禁止商用；商业用途必须替换。完整声明见根目录 `THIRD_PARTY_NOTICES.md`。
