# TTS 统一接口

游戏助理的语音播报抽象层：一个统一调用口，多个可切换后端，失败自动降级。

## 后端

| ID | 说明 | 状态 |
|---|---|---|
| `edge_tts` | Edge 在线语音，音质好，需联网 | 默认首选 |
| `sapi_fallback` | Windows 系统自带语音，机械但稳定 | 断网兜底 |
| `offline_xiaoxiao` | 系统已安装的自然人声（SAPI5 / NaturalVoiceSAPIAdapter） | 可选，需用户自行装语音包 |
| `qwen3_tts` | 本地 TTS 接口占位 | 默认关闭，未实现 |

默认 `auto` 链路是 `edge_tts → sapi_fallback`。第三档需要用户自行安装微软自然人声语音包；设置页探测到**真离线**音色后才会列出，名字带 Online 的只是 Edge 桥接，断网会失败。

## 使用

```bash
pip install pywin32 edge-tts

python tts_interface.py --check
python tts_interface.py "前方的宝藏在右手边第二个山洞。" -o reply.wav
python tts_interface.py "你好" --backend edge_tts -o reply2.wav
```

业务侧只认一个函数：

```python
from tts_interface import get_tts
tts = get_tts()                       # 默认读同目录 config.json
tts.synthesize("矿机缺煤，把传送带接上就行。", "reply.wav")
```

换后端只改 `config.json` 的 `default_backend`，或命令行 `--backend`，业务代码不用动。

## 切换逻辑

- `default_backend = "auto"`：按 `auto_order` 找第一个可用的；合成失败自动降级。
- 指定某个 backend：锁定它，不可用时直接报错，不静默换音色。
- 命令行 `--backend` 优先级最高。

## 说明

- Windows SAPI 音色名随系统版本变化（`Xiaoxiao` / `晓晓` 等），代码里是模糊匹配。
- 音量在合成阶段烘进波形，所以 `winsound` 直放时也生效。
- 微软自然人声语音包有第三方许可，本项目只给安装指引，不内嵌、不分发。详见根目录 `THIRD_PARTY_NOTICES.md`。
