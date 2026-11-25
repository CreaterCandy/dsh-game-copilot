# 第三方声明

本项目新增代码与文档按根目录下的 MIT `LICENSE` 提供；上游插件本体的原始 MIT 声明保留在 `plugin/LICENSE`。下列第三方组件和素材按各自许可单独说明；本项目不对它们的授权作额外承诺。

## 随仓库提供

| 组件 | 来源 | 许可 / 限制 | 说明 |
|---|---|---|---|
| dsh-game-pet 基础插件 | `bigk5780/dsh` | MIT | 本项目在其上二次开发，原 MIT 声明保留在 `plugin/LICENSE` |
| 10 段桌宠动画（webm） | `PC2005-cloud/dsh-pet` | 代码 MIT；**素材开源可用、禁止商用** | 见 `plugin/assets/webm/README.md`。非商用分享可用；商业产品必须替换为自制素材 |
| 提示音与 UI 音效 | `runtime/sounds/` | 来源未在上游标注 | 按原样保留。若用于商业分发，请先核实授权或自行替换 |
| Python 依赖 | `requirements.txt` | 各依赖自身许可 | 由 `pip` 安装，不在本仓库内分发 |

## 运行时下载，不随仓库提交

| 组件 | 来源 | 许可 | 说明 |
|---|---|---|---|
| faster-whisper small 模型 | `Systran/faster-whisper-small`（由 `openai/whisper-small` 转换） | MIT | 首次安装时下载；也可由维护者作为 Release 模型包提供 |
| CTranslate2 / faster-whisper | `SYSTRAN/faster-whisper` | MIT | 本地语音识别引擎，不经 DSH |
| Edge TTS | `rany2/edge-tts` | MIT | 使用公开朗读服务，不随包分发音频资产 |

## 仅提供安装指引，不随包分发

- **NaturalVoiceSAPIAdapter**（`gexgd0419/NaturalVoiceSAPIAdapter`，MIT）：用户自行下载安装；本项目只在系统里探测已安装的音色。
- **微软自然人声语音包**：有第三方许可，不内嵌、不分发、不预置。用户自行安装后，设置页才会列出真离线音色。
- **DSH（DeepSeek Harness）**：提供插件宿主与 HTTP 端口，需用户自行安装；本项目不打包、不修改 DSH 本体。

## 商业使用提示

代码是 MIT，但 `plugin/assets/webm/` 的 10 段素材上游明确禁止商用。要把本项目用于商业产品，至少需要先替换这些动画素材，并核实 `runtime/sounds/` 音效的授权。
