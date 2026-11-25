// plugin.mjs —— 宿主半侧的装配与循环。
//
// 一条自动链，全程零点击：
//   每 checkIntervalMs 探一次前台窗口
//     → 命中游戏（白名单/全屏策略）就开始计时
//     → 到点就：截屏 → 交给模型看图 → 拿回一句台词
//     → 写进 /state，浏览器里的桌宠自己念出来
//   切走游戏 / 关掉开关 → 立刻停手（不再截屏、不再调模型）
import { createReadStream, existsSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本文件所在目录 —— COPILOT_ROOT 等相对路径都从这里推。 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

import { adviseOnce, askQuestion, inspectVision } from './advise.mjs';
import { capturePng, detectForeground } from './collect.mjs';
import {
  ASK_BACKEND_PRESETS,
  ASK_MODEL_PRESETS,
  BUBBLE_STYLE_PRESETS,
  CAPTURE_TARGET_PRESETS,
  DEFAULTS,
  KEEP_API_KEY,
  TTS_BACKEND_PRESETS,
  TTS_VOICE_PRESETS,
  VISION_MODE_PRESETS,
  matchesGame,
  normalizeConfig,
} from './config.mjs';
import { readUserConfig, writeUserConfig } from './config-store.mjs';
import { startOverlayWindow } from './desktop-window.mjs';
import { redactVisionApi, testCustomApi } from './vision-api.mjs';
import { runProbe } from './http-llm.mjs';
import { resolveAskRoute } from './ask-route.mjs';
import { CompanionState } from './state.mjs';
import { moodOf, pickAnimation } from '../shared/agent.mjs';

export const ROUTE_PREFIX = '/dsh-game-copilot-7341';

/** 一键启动拉起的 Python 助理进程（detached，插件退出也不跟着死）。 */
let runtimeChild = null;

/**
 * 真查后台进程，不再只看 runtimeChild：
 *   - DSH 重启后 runtimeChild 丢了，但 detached 的 Python 可能还活着；
 *   - 反过来，spawn 成功但 Python 立刻崩（缺 config.json / 依赖），
 *     runtimeChild 曾经非 null，界面却报"已启动"——就是这次踩的坑。
 * 用命令行特征认两个守护：按键守护 ptt_voice.pyw、播报桥 pet_voice_bridge.py。
 */
let processScan = { at: 0, data: null };
function detectRuntimeProcesses() {
  const result = { ptt: null, bridge: null, error: null };
  // 走独立 .ps1 + -File：-Command 内嵌引号会被 PowerShell 吃掉（实测 WQL LIKE 全挂）。
  const script = path.join(PACKAGE_ROOT, 'runtime', 'runtime-procs.ps1');
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
      {
        encoding: 'utf8',
        timeout: 6000,
        windowsHide: true,
      },
    );
    for (const line of String(out).split(/\r?\n/)) {
      const m = /^(PTT|BRIDGE)\s+(\d+)$/.exec(line.trim());
      if (!m) continue;
      if (m[1] === 'PTT') result.ptt = Number(m[2]);
      else result.bridge = Number(m[2]);
    }
  } catch (error) {
    result.error = errorText(error);
  }
  return result;
}
function runtimeProcesses(force = false) {
  if (!force && processScan.data && Date.now() - processScan.at < 1200) return processScan.data;
  processScan = { at: Date.now(), data: detectRuntimeProcesses() };
  return processScan.data;
}
function logTail(file, lines = 6) {
  try {
    return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/**
 * 设置页「对话日志 / 排障」的日志源清单。
 * 路径里的 HOME 与 /runtime/start 落盘日志用同一个基准（DSH_HOME || homedir），
 * 否则用户从设置页点"启动助理"写的日志，这里却去别的目录读，会显示"无日志"。
 */
function logSources() {
  const home = process.env.DSH_HOME || homedir();
  return {
    copilot: { label: '主对话日志', file: path.join(COPILOT_ROOT, 'copilot_log.jsonl'), jsonl: true },
    bridge: { label: '播报桥日志', file: path.join(COPILOT_ROOT, 'pet_bridge_log.jsonl'), jsonl: true },
    runtime: { label: '按键守护输出', file: path.join(home, 'dsh-game-copilot-runtime.log'), gbk: true },
    bridgeout: { label: '播报桥输出', file: path.join(home, 'dsh-game-copilot-bridge.log'), gbk: true },
  };
}

/** GBK 日志解码：Windows 下 Python stdout 重定向写的是 cp936，按 utf8 读全是乱码。 */
function decodeLogBytes(buf, gbk) {
  if (!gbk) return buf.toString('utf8');
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

/** 一条 voice_turn 的隐私字段：默认打码，前端开了「显示原文」才由客户端解封。 */
const LOG_SECRET_FIELDS = ['question', 'answer', 'reasoning'];
function maskJsonlRow(row, plain) {
  const out = { ...row };
  if (!plain) {
    for (const k of LOG_SECRET_FIELDS) {
      if (out[k] !== undefined && out[k] !== null && out[k] !== '') out[k] = '••••（已隐藏，勾选「显示原文」查看）';
    }
  }
  return out;
}

/** 包根目录：/anim/<名>.webm 与置顶小窗那一页都从这里读。 */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ANIMATION_DIR = path.join(PACKAGE_ROOT, 'assets', 'webm');
const OVERLAY_HTML = path.join(PACKAGE_ROOT, 'runtime', 'overlay', 'overlay.html');
/** 窗口位置单独存一份（用户拖过就该记住，不该改写 profile 的 patch） */
const POSITION_FILE = path.join(process.env.DSH_HOME || path.join(homedir(), '.dsh'), 'dsh-game-copilot-window.json');

/**
 * 自带动画清单（只算一次）。
 * 为什么要暴露给小窗：小窗要按"本地到底有哪些素材"来排回落链——
 * 本地没有的动画就别去试它（否则要等 404/超时才回落，观感是"卡一下才出小人"）。
 */
const BUNDLED_ANIMATIONS = (() => {
  try {
    return readdirSync(ANIMATION_DIR)
      .filter((name) => name.toLowerCase().endsWith('.webm'))
      .map((name) => name.slice(0, -'.webm'.length));
  } catch {
    return [];
  }
})();

/** /state 只暴露这几片（内部状态整包不出门）。 */
const STATE_KEYS = ['presence', 'advice', 'lastError', 'pet', 'typeInput'];

/**
 * 插件入口。
 * @param ctx Cordis 上下文（webServer / llm / agentDefaultModel 已由 inject 声明）
 * @param config 这一行的 config（**第二个参数**！Cordis 不允许直接读 ctx.config，
 *   直接读会抛 `cannot get property "config" without inject` 并把整个插件挂掉——
 *   DSH 的插件契约是 `apply(ctx, config)`，见官方 cordis-plugin-development/references/host-plugin.md）
 */
export function apply(ctx, config) {
  const state = new CompanionState();
  // 用户覆盖（设置页改的）叠在行配置之上：行配置是"出厂默认/部署默认"，用户改的进 config.json
  const settings = normalizeConfig({ ...(config ?? {}), ...readUserConfig() });
  const log = (level, message) => {
    const logger = ctx.logger ?? console;
    const fn = typeof logger[level] === 'function' ? logger[level].bind(logger) : null;
    if (fn) fn(`dsh-game-copilot: ${message}`);
  };

  /** 一次游戏会话的运行态 */
  const session = {
    /** 当前生效的配置（/config 可热改） */
    settings,
    /** 正在玩的游戏（null = 没在玩） */
    detection: null,
    startedAt: 0,
    lastSpokeAt: 0,
    /** 最近几句说过的话，喂回下一次请求当上下文 */
    notes: [],
    busy: false,
    timer: null,
    /** 诊断用：最近一次失败原因 */
    lastError: null,
    /** 上一张截图的时间与描述（snapshotTtlMs 用的缓存） */
    snapshot: null,
    /** 上次写进 state 的那句 advice 的 at：publish 每秒跑，但同一句只写一次，
     *  否则 advice counter 每秒递增，前端气泡计时器被无限重置 → 永不消失。 */
    publishedAdviceAt: 0,
  };
  /** 置顶小窗的句柄：Ctrl+Alt+T 要靠它判断"气泡输入条能不能弹在宠物头顶"。 */
  let overlayHandle = null;

  // 上次拖到哪里，这次还放那里（patch 里的 windowX/windowY 优先）
  if (session.settings.windowX === null || session.settings.windowY === null) {
    const remembered = readPosition();
    if (remembered) session.settings = { ...session.settings, windowX: remembered.x, windowY: remembered.y };
  }

  publish();

  /** 检测节拍器：间隔可热改，所以留一个可重建的句柄（重建时先清旧的）。 */
  let checkTimer = null;
  const startTimer = () => {
    if (checkTimer) clearInterval(checkTimer);
    checkTimer = setInterval(() => {
      void tick();
    }, Math.max(1000, session.settings.checkIntervalMs));
  };
  startTimer();

  ctx.effect(
    () => () => {
      if (checkTimer) clearInterval(checkTimer);
      checkTimer = null;
      if (session.timer) clearTimeout(session.timer);
      session.timer = null;
    },
    'dsh-game-copilot: automation loop',
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          try {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            await handleRoute(req, res, url);
          } catch (error) {
            sendJson(res, 500, { ok: false, reason: 'internal', message: errorText(error) });
          }
        },
      }),
    'dsh-game-copilot: /dsh-game-copilot-7341 routes',
  );

  // 置顶小窗：等 webServer 拿到端口后拉起（没有 Electron 就只告警，浏览器浮层照常）
  ctx.effect(() => {
    if (session.settings.overlay !== 'window') return () => {};
    let overlay = null;
    let cancelled = false;

    const waitForPort = async () => {
      for (let attempt = 0; attempt < 30 && !cancelled; attempt += 1) {
        const port = typeof ctx.webServer?.port === 'number' ? ctx.webServer.port : 0;
        if (port > 0) {
          overlay = startOverlayWindow({
            port,
            // 尺寸也走配置：小窗太小放不下一句话，太大会挡住游戏
            width: session.settings.windowWidth,
            height: session.settings.windowHeight,
            x: session.settings.windowX,
            y: session.settings.windowY,
            log,
          });
          overlayHandle = overlay;
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (!cancelled) log('warn', 'webServer 端口一直没就绪，置顶小窗没起来');
    };

    void waitForPort();
    return () => {
      cancelled = true;
      overlay?.stop();
      overlayHandle = null;
    };
  }, 'dsh-game-copilot: desktop overlay window');

  /**
   * 查询 DSH 会话里连接的模型服务状态（若对应插件提供 usage 接口）。
   * 拿不到就返回未连接，不影响自定义端点链路。
   */
  async function probeWorkBuddy() {
    try {
      const port = typeof ctx.webServer?.port === 'number' ? ctx.webServer.port : 0;
      if (!port) return { ok: false, connected: false, message: 'webServer 端口未就绪' };
      const response = await fetch(`http://127.0.0.1:${port}/plugins/dsh-connect-workbuddy/usage`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return { ok: false, connected: false, message: `探测返回 ${response.status}` };
      const data = await response.json();
      const connected = data?.status === 'signed-in';
      return {
        ok: true,
        connected,
        status: data?.status ?? 'unknown',
        accountName: data?.accountName ?? '',
        region: data?.region ?? '',
        message: connected
          ? `已连接：${data?.accountName ?? 'WorkBuddy 账号'}（${data?.region ?? ''}）`
          : '未连接（去 DSH 左侧「WorkBuddy」面板登录）',
      };
    } catch (error) {
      return { ok: false, connected: false, message: `探测失败：${errorText(error)}` };
    }
  }

  async function handleRoute(req, res, url) {
    const route = url.pathname.slice(ROUTE_PREFIX.length) || '/';
    const method = (req.method ?? 'GET').toUpperCase();

    if (method === 'GET' && (route === '/state' || route === '/')) {
      sendJson(res, 200, state.snapshot(STATE_KEYS), { 'cache-control': 'no-store' });
      return;
    }
    // 会话模型连接状态：用于设置页提示，拿不到接口时保持未连接。
    // 真状态在 DSH 自己的插件接口里，这里代理并压成几个字段。
    if (method === 'GET' && route === '/workbuddy/status') {
      const status = await probeWorkBuddy();
      sendJson(res, 200, status, { 'cache-control': 'no-store' });
      return;
    }
    // 设置页（独立 HTML，和 DSH 设置面板共用同一份文件）
    if (method === 'GET' && route === '/settings') {
      const file = path.resolve(PACKAGE_ROOT, '..', 'settings.html');
      if (!existsSync(file)) {
        sendJson(res, 404, { ok: false, message: `设置页文件缺失：${file}` });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      createReadStream(file).pipe(res);
      return;
    }
    // 置顶小窗要加载的那一页（纯 DOM，无依赖）
    if (method === 'GET' && route === '/overlay') {
      await sendOverlayHtml(res);
      return;
    }
    // 小窗拖动后回传坐标 → 记住，下次启动还放那儿
    if (method === 'POST' && route === '/position') {
      const body = await readJson(req);
      const x = Number(body?.x);
      const y = Number(body?.y);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        session.settings = { ...session.settings, windowX: Math.round(x), windowY: Math.round(y) };
        savePosition(session.settings);
      }
      sendJson(res, 200, { ok: true });
      return;
    }
    // 小窗的存活探测：宿主在就 200，宿主没了它自己退出
    if (method === 'POST' && route === '/ping') {
      sendJson(res, 200, { ok: true });
      return;
    }
    // Ctrl+Alt+T：热键守护请小窗在宠物头顶弹气泡式输入条。
    // 热键在 Python 进程、小窗在独立 Electron 进程，state 是两边本来就在轮询的公共通道。
    if (method === 'POST' && route === '/type-ask/start') {
      const body = await readJson(req);
      const at = Number(body?.at) || Date.now();
      state.write('typeInput', { at, active: true });
      sendJson(res, 200, { ok: true, overlay: Boolean(overlayHandle?.running?.()) });
      return;
    }
    // 输入条取消/超时：把状态片翻回 inactive，下一次热键才能正确重开。
    if (method === 'POST' && route === '/type-ask/end') {
      state.write('typeInput', { at: Date.now(), active: false });
      sendJson(res, 200, { ok: true });
      return;
    }
    // 输入条提交：复用 ask.py 的完整链路（截图判断 + 模型 + 气泡 + TTS），
    // 不另写一套打字专用逻辑——语音、剪贴板、打字三条路必须始终同答案。
    if (method === 'POST' && route === '/type-ask/submit') {
      const body = await readJson(req);
      const question = String(body?.question ?? '').trim();
      state.write('typeInput', { at: Date.now(), active: false });
      if (!question) {
        sendJson(res, 200, { ok: false, reason: 'empty-question', message: '问题为空' });
        return;
      }
      const python = copilotPython();
      const script = path.join(COPILOT_ROOT, 'ask.py');
      if (!python || !existsSync(script)) {
        sendJson(res, 200, {
          ok: false,
          reason: 'no-python',
          message: !python ? '没找到 runtime/venv 里的 python.exe，先跑 setup.ps1' : `找不到 ${script}`,
        });
        return;
      }
      try {
        const child = spawn(python, [script, question], {
          cwd: COPILOT_ROOT,
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        child.unref();
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 200, { ok: false, reason: 'spawn-failed', message: errorText(error) });
      }
      return;
    }
    if (method === 'GET' && route === '/config') {
      sendJson(
        res,
        200,
        {
          ok: true,
          config: publicConfig(session.settings),
          defaults: DEFAULTS,
          askPresets: ASK_MODEL_PRESETS,
          askBackendPresets: ASK_BACKEND_PRESETS,
          visionModePresets: VISION_MODE_PRESETS,
          ttsVoicePresets: TTS_VOICE_PRESETS,
          ttsBackendPresets: TTS_BACKEND_PRESETS,
          bubbleStylePresets: BUBBLE_STYLE_PRESETS,
          captureTargetPresets: CAPTURE_TARGET_PRESETS,
          userConfig: readUserConfig(),
        },
        { 'cache-control': 'no-store' },
      );
      return;
    }
    if (method === 'POST' && route === '/config') {
      const body = await readJson(req);
      const patch = body && typeof body === 'object' ? body : {};
      // 只接受已知字段，避免设置页之外的乱写污染配置
      const accepted = {};
      for (const key of Object.keys(DEFAULTS)) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) accepted[key] = patch[key];
      }
      // apiKey 的哨兵值 __KEEP__ = "沿用已存的"，绝不能拿它覆盖真 Key
      if (accepted.visionApi && typeof accepted.visionApi === 'object' && accepted.visionApi.apiKey === KEEP_API_KEY) {
        accepted.visionApi = { ...accepted.visionApi, apiKey: session.settings.visionApi?.apiKey ?? '' };
      }
      // 作答槽的 Key 同样用 __KEEP__ 哨兵，避免设置页回传把真 Key 洗掉
      if (accepted.askApi && typeof accepted.askApi === 'object' && accepted.askApi.apiKey === KEEP_API_KEY) {
        accepted.askApi = { ...accepted.askApi, apiKey: session.settings.askApi?.apiKey ?? '' };
      }
      session.settings = normalizeConfig({ ...session.settings, ...accepted });
      // 落盘（用户覆盖层），重启后仍然生效
      const persisted = writeUserConfig(accepted);
      session.detection = null;
      session.startedAt = 0;
      publish();
      reschedule();
      sendJson(res, 200, { ok: true, persisted, config: publicConfig(session.settings) });
      return;
    }
    // 设置页「识图」卡片用：现在到底认不认得出可用的识图模型，认出来的是哪些
    if (method === 'GET' && route === '/vision') {
      const report = await inspectVision({ ctx, config: session.settings });
      sendJson(res, 200, report, { 'cache-control': 'no-store' });
      return;
    }
    // Python 侧（ask.py）在截图**之前**问一句：现在是不是盲答档。
    // 盲答档不许截图——没人看图还每句抓一张屏，既慢又把画面发给了不需要它的端点。
    if (method === 'GET' && route === '/vision/capability') {
      const chosen = resolveAskRoute(session.settings);
      sendJson(
        res,
        200,
        {
          ok: true,
          route: chosen.route,
          blind: chosen.route === 'blind',
          shot: chosen.route === 'blind' ? 'never' : null,
          via: chosen.via ?? '',
        },
        { 'cache-control': 'no-store' },
      );
      return;
    }
    // 数字探针：给作答槽发一张随机 4 位数字图，答对才算能看图。
    // body 可带未保存的草稿（先探再存）。超时按 no 走，但不把 unknown 洗成永久 no。
    if (method === 'POST' && route === '/vision/probe') {
      const body = await readJson(req);
      const draft = body && typeof body === 'object' ? body.api ?? body : {};
      const merged = normalizeConfig({
        ...session.settings,
        askApi: { ...session.settings.askApi, ...draft },
      }).askApi;
      if (merged.apiKey === KEEP_API_KEY) merged.apiKey = session.settings.askApi?.apiKey ?? '';
      const result = await runProbe({ api: merged, timeoutMs: 20000 });
      if (result.status === 'yes' || (result.status === 'no' && !result.timeout)) {
        const patch = { visionProbe: { status: result.status, checkedAt: Date.now() } };
        session.settings = normalizeConfig({ ...session.settings, ...patch });
        writeUserConfig(patch);
        publish();
      }
      sendJson(res, 200, { ok: true, ...result });
      return;
    }
    // 设置页「测一下这个视觉 API」：body 可带未保存的草稿，这样能先测再存
    if (method === 'POST' && route === '/vision/test') {
      const body = await readJson(req);
      const draft = body && typeof body === 'object' ? body : {};
      const merged = normalizeConfig({
        ...session.settings,
        visionApi: { ...session.settings.visionApi, ...draft },
      });
      if (merged.visionApi?.apiKey === KEEP_API_KEY) {
        merged.visionApi = { ...merged.visionApi, apiKey: session.settings.visionApi?.apiKey ?? '' };
      }
      const result = await testCustomApi({ api: merged.visionApi, timeoutMs: 20000 });
      sendJson(res, 200, result);
      return;
    }
    // 设置页「试听」：用当前 tts 设置起一个 python 念一句，听到的就是下一句话的声音
    if (method === 'POST' && route === '/tts/preview') {
      const body = await readJson(req);
      const result = await previewTts({ settings: session.settings, body });
      if (!result.ok) log('warn', `tts preview failed: ${result.message}`);
      sendJson(res, 200, result);
      return;
    }
    // 设置页「本地自然人声」：探测 SAPI 里有没有真离线音色（Edge 桥接不算）。
    if (method === 'GET' && route === '/tts/probe') {
      sendJson(res, 200, await probeTts());
      return;
    }
    // 设置页「对话日志 / 排障」：读本地日志给自助排障用。
    // ?source=copilot|bridge|runtime|bridgeout &tail=N &plain=1
    // 隐私：question/answer/reasoning 默认打码，只有显式 plain=1 才出原文。
    if (method === 'GET' && route === '/logs') {
      const sources = logSources();
      const key = String(url.searchParams.get('source') || 'copilot');
      const src = sources[key];
      if (!src) {
        sendJson(res, 200, { ok: false, message: '未知日志源', sources: Object.keys(sources) });
        return;
      }
      const tail = Math.max(1, Math.min(500, Number(url.searchParams.get('tail')) || 120));
      const plain = url.searchParams.get('plain') === '1';
      let text = '';
      let exists = existsSync(src.file);
      let bytes = 0;
      if (exists) {
        try {
          const buf = await readFile(src.file);
          bytes = buf.length;
          // 大文件只读尾部，避免整份 GBK 日志（可能几十 MB）全读进内存解码。
          // JSONL/文本按行切：先从末尾取足够字节，再丢弃第一行（可能被截断）。
          if (buf.length > 2 * 1024 * 1024) {
            const tailBuf = buf.subarray(buf.length - 2 * 1024 * 1024);
            const cut = tailBuf.indexOf(0x0a);
            text = decodeLogBytes(cut >= 0 ? tailBuf.subarray(cut + 1) : tailBuf, src.gbk);
          } else {
            text = decodeLogBytes(buf, src.gbk);
          }
        } catch (error) {
          sendJson(res, 200, { ok: false, message: `读取失败：${errorText(error)}` });
          return;
        }
      }
      const allLines = text.split(/\r?\n/).filter(Boolean);
      const sliced = allLines.slice(-tail);
      let rows;
      if (src.jsonl) {
        rows = sliced.map((line, i) => {
          try {
            return maskJsonlRow(JSON.parse(line), plain);
          } catch {
            return { at: '', kind: 'raw', raw: line.slice(0, 500), _i: i };
          }
        });
      } else {
        // 纯文本 stdout 也含问答原文（"识别：…"/"回答：…"），默认一并打码；
        // 保留前缀好让用户看出"这条是识别还是回答"，只是内容隐藏。
        rows = sliced.map((line) => ({
          at: '',
          kind: 'text',
          text: plain
            ? line
            : line.replace(/^(识别|回答|出错)[：:]/, (m) => m + '••••（已隐藏，勾选「显示原文」查看）'),
        }));
      }
      // 统一倒序（最新在上）。rows 里 _i 只是坏行兜底，不暴露给前端。
      rows.forEach((r) => { delete r._i; });
      rows.reverse();
      sendJson(
        res,
        200,
        {
          ok: true,
          source: key,
          label: src.label,
          file: src.file,
          exists,
          bytes,
          shown: rows.length,
          totalLines: allLines.length,
          truncated: allLines.length > sliced.length,
          rows,
        },
        { 'cache-control': 'no-store' },
      );
      return;
    }
    // 一键启动：把 start_copilot.cmd 收进设置页（§13.12）。
    // 子进程 detached + unref，stdio 必须落文件——不落盘的话 detached 进程
    // 一旦写 stdout 就会把管道写满卡死，而且出事没有任何日志可查。
    if (method === 'GET' && route === '/runtime/status') {
      const procs = runtimeProcesses();
      sendJson(res, 200, {
        ok: true,
        pttRunning: Boolean(procs.ptt),
        pttPid: procs.ptt,
        bridgeRunning: Boolean(procs.bridge),
        bridgePid: procs.bridge,
        running: Boolean(procs.ptt || procs.bridge),
        autoEnabled: Boolean(session.settings.enabled),
        script: existsSync(path.join(COPILOT_ROOT, 'ptt_voice.pyw')),
        bridgeScript: existsSync(path.join(COPILOT_ROOT, 'pet_voice_bridge.py')),
        python: Boolean(copilotPython()),
        error: procs.error,
      });
      return;
    }
    if (method === 'POST' && route === '/runtime/start') {
      const python = copilotPython();
      const script = path.join(COPILOT_ROOT, 'ptt_voice.pyw');
      const bridge = path.join(COPILOT_ROOT, 'pet_voice_bridge.py');
      if (!python || !existsSync(script)) {
        sendJson(res, 200, {
          ok: false,
          message: !python ? '没找到 runtime/venv 里的 python.exe，先跑 setup.ps1' : `找不到 ${script}`,
        });
        return;
      }
      const before = runtimeProcesses(true);
      try {
        const logFile = path.join(process.env.DSH_HOME || homedir(), 'dsh-game-copilot-runtime.log');
        const spawnDetached = (target, logName) => {
          const fd = openSync(logName, 'a');
          const child = spawn(python, [target], {
            cwd: COPILOT_ROOT,
            detached: true,
            stdio: ['ignore', fd, fd],
            windowsHide: true,
          });
          child.unref();
          return child;
        };
        if (!before.ptt) {
          runtimeChild = spawnDetached(script, logFile);
          runtimeChild.on('exit', () => { runtimeChild = null; });
        }
        // 播报桥一起起：它只轮询 /state，没新建议就空转，开销可忽略。
        // 以前只在「自动开口」开着时起，结果状态条永远显示"播报桥 未运行"，
        // 用户分不清是没启动还是自动开口关着——两个都起来，状态一眼可见。
        let bridgeStarted = false;
        if (existsSync(bridge) && !before.bridge) {
          spawnDetached(bridge, path.join(process.env.DSH_HOME || homedir(), 'dsh-game-copilot-bridge.log'));
          bridgeStarted = true;
        }
        // ★ 关键：spawn 成功 ≠ 跑起来。等一下真查进程，崩了就把日志尾巴给用户。
        await new Promise((r) => setTimeout(r, 900));
        const after = runtimeProcesses(true);
        if (!after.ptt) {
          sendJson(res, 200, {
            ok: false,
            message: `按键守护启动后立刻退出。日志：${logFile}\n${logTail(logFile)}`,
          });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          already: Boolean(before.ptt),
          pttPid: after.ptt,
          bridgePid: after.bridge,
          bridgeStarted,
          autoEnabled: Boolean(session.settings.enabled),
          message: '已启动',
          log: logFile,
        });
      } catch (error) {
        sendJson(res, 200, { ok: false, message: errorText(error) });
      }
      return;
    }
    if (method === 'POST' && route === '/runtime/stop') {
      const procs = runtimeProcesses(true);
      for (const pid of [procs.ptt, procs.bridge]) {
        if (!pid) continue;
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // pythonw 有时不接 SIGTERM，退到 taskkill（只杀我们刚查到的这两个 PID）
          try {
            execFileSync('taskkill', ['/PID', String(pid), '/F'], {
              timeout: 5000,
              windowsHide: true,
              stdio: 'ignore',
            });
          } catch { /* 已经退出了 */ }
        }
      }
      if (runtimeChild && !runtimeChild.killed) {
        try { runtimeChild.kill(); } catch { /* 已经退出了 */ }
      }
      runtimeChild = null;
      processScan = { at: 0, data: null };
      sendJson(res, 200, { ok: true, stopped: [procs.ptt, procs.bridge].filter(Boolean) });
      return;
    }
    // 诊断用：立刻跑一轮（不看间隔、不写"间隔已满足"的状态），返回这一轮的结论
    if (method === 'POST' && route === '/once') {
      if (session.busy) {
        sendJson(res, 200, { ok: false, reason: 'busy', message: '上一轮还没跑完' });
        return;
      }
      const result = await runCycle({ force: true });
      sendJson(res, 200, result);
      return;
    }
    // 按键问答：外部（Python 按键脚本）把「问题 + 截图」POST 进来，
    // 回答写进 /state 驱动气泡与动画，同时把结果回给调用方去念。
    // 截图 base64 可能几百 KB，所以这条路由单独放宽 body 上限。
    if (method === 'POST' && route === '/ask') {
      const body = await readJson(req, 12 * 1024 * 1024);
      const result = await answerQuestion(body);
      sendJson(res, 200, result);
      return;
    }
    // 诊断用：只看一眼前台窗口，不截屏不调模型
    if (method === 'GET' && route === '/probe') {
      const detection = await detectForeground();
      sendJson(res, 200, { ok: true, detection, matched: isGame(detection) }, { 'cache-control': 'no-store' });
      return;
    }
    // 本插件自带的动画素材（可选）：命中就顺手，没放素材就 404，客户端会回落到 dsh-pet。
    if (method === 'GET' && route.startsWith('/anim/')) {
      await sendAnimation(res, route.slice('/anim/'.length));
      return;
    }
    sendJson(res, 404, { ok: false, reason: 'not-found', message: `no such route: ${route}` });
  }

  /** 探一次前台窗口，更新"在不在玩"的判定。 */
  async function tick() {
    if (!session.settings.enabled) {
      if (session.detection) {
        session.detection = null;
        session.startedAt = 0;
        publish();
      }
      return;
    }
    const detection = await detectForeground();
    const playing = isGame(detection);
    if (!playing) {
      if (session.detection) {
        log('info', `game left: ${session.detection.process}`);
        session.detection = null;
        session.startedAt = 0;
        session.notes = [];
        session.snapshot = null;
        publish();
      }
      return;
    }
    if (session.detection?.hwnd !== detection.hwnd) {
      log('info', `game detected: ${detection.title || detection.process}`);
      session.startedAt = Date.now();
      session.notes = [];
      session.snapshot = null;
      session.lastSpokeAt = 0;
    }
    session.detection = detection;
    publish();

    const now = Date.now();
    if (session.busy) return;
    if (now - session.startedAt < session.settings.warmupMs) return;
    if (session.lastSpokeAt && now - session.lastSpokeAt < session.settings.minGapMs) return;
    if (session.lastSpokeAt && now - session.lastSpokeAt < session.settings.intervalSec * 1000) return;
    await runCycle({ force: false });
  }

  /** 跑一轮：截屏 → 看图 → 说话。 */
  async function runCycle({ force }) {
    if (session.busy) return { ok: false, reason: 'busy' };
    session.busy = true;
    const startedAt = Date.now();
    let shot = null;
    try {
      const detection = session.detection ?? (await detectForeground());
      if (!session.settings.enabled && !force) return { ok: false, reason: 'disabled' };
      if (!force && !isGame(detection)) return { ok: false, reason: 'not-playing' };
      if (!session.detection) {
        session.detection = detection;
        session.startedAt = Date.now();
      }

      const selection = resolveSelection(ctx, session.settings);
      if (!selection.provider || !selection.model) {
        throw new Error('没有可用的模型：当前对话没选模型，插件配置里也没写 provider/model');
      }

      let image = null;
      const fresh = !session.snapshot || Date.now() - session.snapshot.at <= session.settings.snapshotTtlMs;
      if (fresh && session.snapshot) {
        image = session.snapshot.data;
      } else {
        // 截图范围：auto/window → 优先截当前窗口；primary/secondary/all → 截整块屏。
        // 窗口拿不到（hwnd=0）时兜底截主屏，而不是双屏拼接——拼完每块屏会被压成 800 多像素宽。
        const target = session.settings.captureTarget || 'auto';
        const useWindow = target === 'auto' || target === 'window';
        const hwnd = useWindow ? Number(detection.hwnd ?? 0) : 0;
        const monitor = useWindow ? 'primary' : target;
        shot = await capturePng({ hwnd, monitor });
        image = shot.data;
      }

      const result = await adviseOnce({
        ctx,
        config: session.settings,
        image,
        detection,
        notes: session.notes,
        elapsedMs: Date.now() - session.startedAt,
        selection,
      });

      if (!result.ok) {
        session.lastError = { at: Date.now(), reason: result.reason, message: result.message ?? '' };
        log('warn', `advice failed: ${result.reason} ${result.message ?? ''}`);
        // 识图失败时把"候选是怎么算出来的"打一行日志：这类问题光看报错没法定位
        if (result.reason === 'vision-failed' || result.reason === 'vision-model-missing') {
          try {
            const report = await inspectVision({ ctx, config: session.settings });
            log(
              'warn',
              `vision probe: providers=${JSON.stringify(report.providers)} candidates=${JSON.stringify(report.candidates)}`,
            );
          } catch {
            // 探测再失败就算了，别让它影响主流程
          }
        }
        publish();
        return { ok: false, ...session.lastError, elapsedMs: Date.now() - startedAt };
      }

      session.lastError = null;
      if (image) session.snapshot = { at: Date.now(), data: image, screen: result.screen };
      if (result.say) {
        // 历史里同时带上"当时画面"：这样下一句能接着上一幕讲，
        // 而不是每次都从零描述（实测这样建议更贴当前局面）。
        session.notes.push(result.screen ? `[画面] ${result.screen} → [我说] ${result.say}` : result.say);
        const limit = session.settings.historyLimit;
        if (limit > 0 && session.notes.length > limit) session.notes.splice(0, session.notes.length - limit);
      }
      // 先算"上一句到现在隔了多久"，再刷新 lastSpokeAt（否则永远是 0）
      const previousSpeakAt = session.lastSpokeAt;
      const idleSeconds = previousSpeakAt ? Math.round((Date.now() - previousSpeakAt) / 1000) : 0;
      session.lastSpokeAt = Date.now();
      const mood = moodOf({ say: result.say, idleSeconds });
      session.lastAdvice = {
        at: session.lastSpokeAt,
        say: result.say,
        screen: result.screen,
        mood,
        animation: pickAnimation({ mood, seed: session.lastSpokeAt }),
        game: detection.title || detection.process || '',
      };
      publish();
      log('info', `said: ${result.say}`);
      return { ok: true, screen: result.screen, say: result.say, mood, elapsedMs: Date.now() - startedAt };
    } catch (error) {
      session.lastError = { at: Date.now(), reason: 'cycle-error', message: errorText(error) };
      log('warn', `cycle failed: ${errorText(error)}`);
      publish();
      return { ok: false, ...session.lastError };
    } finally {
      if (shot) await shot.dispose();
      session.busy = false;
    }
  }

  /**
   * 外部按键问答：问题 + 截图 → 一句完整回答。
   * 和 runCycle 的区别：不自动截图（截图由 Python 那边拍，它更会找游戏窗口）、
   * 不走 45 秒节拍、答完写 `source:'ask'` 标记（播报桥据此跳过，避免念两遍）。
   */
  async function answerQuestion(body) {
    if (!session.settings.askEnabled) {
      return { ok: false, reason: 'ask-disabled', message: '按键问答开关是关的（设置页 → 游戏助理）' };
    }
    const question = String(body?.question ?? '').trim();
    if (!question) return { ok: false, reason: 'empty-question', message: '问题为空' };

    const startedAt = Date.now();
    const image = typeof body?.image === 'string' && body.image ? Buffer.from(body.image, 'base64') : null;
    const imageType = typeof body?.imageType === 'string' && body.imageType ? body.imageType : 'image/jpeg';
    const history = normalizeHistory(body?.history, session.settings.memoryLimit, session.settings.memoryChars);
    const { selection, preferLocal, key: askKey } = resolveAskSelection(ctx, session.settings, body?.model);

    let detection = session.detection;
    if (!detection) {
      try {
        detection = await detectForeground();
      } catch {
        detection = null;
      }
    }

    // 立刻推一帧"正在想"，让气泡先出来——模型要跑几秒，不给反馈像卡死
    // heard：把 ASR 转出来的原文回显到气泡顶部。听错时（"除以3"→"除13"）
    // 一眼就能分辨是语音识别错了还是模型答错了，比事后翻日志快得多。
    const heard = session.settings.echoQuestion ? question : '';
    state.write('advice', {
      at: startedAt,
      say: '',
      screen: '',
      mood: 'think',
      animation: pickAnimation({ mood: 'think', seed: startedAt }),
      game: detection?.title || detection?.process || '',
      source: 'ask',
      pending: true,
      heard,
    });
    // 小窗在"没在游戏"时是 3 秒轮询一次（气泡会晚 3 秒才冒）。
    // 玩家按了键就说明人正坐在电脑前，先临时把 playing 标成 true，
    // 让小窗按 1 秒轮询——"思考中"动画和最终气泡都能及时出现。
    state.write('presence', presencePayload({ playing: true, busy: true }));

    try {
      const result = await askQuestion({
        ctx,
        config: session.settings,
        image,
        imageType,
        question,
        history,
        detection,
        selection,
        preferLocal,
      });

      if (!result.ok) {
        session.lastError = { at: Date.now(), reason: result.reason, message: result.message ?? '' };
        log('warn', `ask failed: ${result.reason} ${result.message ?? ''}`);
        publish();
        return { ...result, elapsedMs: Date.now() - startedAt };
      }

      const now = Date.now();
      const mood = moodOf({ say: result.answer, idleSeconds: 0 });
      session.lastError = null;
      session.lastAdvice = {
        at: now,
        say: result.answer,
        screen: result.screen || '',
        mood,
        animation: pickAnimation({ mood, seed: now }),
        game: detection?.title || detection?.process || '',
        source: 'ask',
        heard,
        via: result.via ?? '',
      };
      // 记忆：把这一轮记进会话 notes，自动看下一轮也会接着这个语境
      if (session.settings.memoryLimit > 0) {
        session.notes.push(`[我问] ${question} → [我答] ${result.answer}`);
        if (session.notes.length > session.settings.memoryLimit * 4) {
          session.notes.splice(0, session.notes.length - session.settings.memoryLimit * 4);
        }
      }
      publish();
      log('info', `ask ok in ${now - startedAt}ms (${result.mode}, ${result.via ?? '?'}): ${result.answer.slice(0, 40)}`);
      return {
        ...result,
        elapsedMs: now - startedAt,
        animation: session.lastAdvice.animation,
        modelKey: askKey,
        // 到底是哪个模型出的这句话：custom:* = 自定义端点，provider/model = DSH 会话模型
        answeredBy: result.via ?? '',
      };
    } catch (error) {
      session.lastError = { at: Date.now(), reason: 'ask-error', message: errorText(error) };
      log('warn', `ask crashed: ${errorText(error)}`);
      publish();
      return { ok: false, reason: 'ask-error', message: errorText(error), elapsedMs: Date.now() - startedAt };
    }
  }

  function isGame(detection) {
    if (!detection?.available) return false;
    if (session.settings.ignoreMinimized && detection.minimized) return false;
    if (session.settings.requireFullscreen && !detection.fullscreen) return false;
    const list = session.settings.games;
    if (!Array.isArray(list) || list.length === 0) return true;
    return list.some((pattern) => matchesGame(pattern, detection));
  }

  function publish() {
    state.write('presence', presencePayload());
    // 同一句话别反复写：counter 每次都涨，前端会当成"新气泡"重放并重置消失计时器。
    // at 是每句话的唯一时间戳（runCycle / answerQuestion 都用它），变了才是新句。
    if (session.lastAdvice && (session.lastAdvice.at ?? 0) !== session.publishedAdviceAt) {
      session.publishedAdviceAt = session.lastAdvice.at ?? 0;
      state.write('advice', session.lastAdvice);
    }
    state.write('lastError', session.lastError);
    // 小窗据此排回落链：本地有就直接用自己的素材，不去试不存在的地址
    // 顺带把气泡外观发过去：小窗是独立页面，读不到设置，只能靠这一帧带走
    state.write('pet', {
      bundled: BUNDLED_ANIMATIONS,
      idle: '待机呼吸休闲',
      style: session.settings.bubbleStyle,
      fontSize: session.settings.bubbleFontSize,
      maxWidth: session.settings.bubbleMaxWidth,
    });
  }

  /** presence 这一片的数据形状（按键问答也要临时改 playing，所以抽出来复用）。 */
  function presencePayload(extra = {}) {
    const detection = session.detection;
    return {
      playing: Boolean(detection),
      game: detection ? detection.title || detection.process || '' : '',
      process: detection?.process ?? '',
      fullscreen: Boolean(detection?.fullscreen),
      playingForSec: session.startedAt ? Math.round((Date.now() - session.startedAt) / 1000) : 0,
      busy: session.busy,
      enabled: session.settings.enabled,
      intervalSec: session.settings.intervalSec,
      ...extra,
    };
  }

  function reschedule() {
    // 间隔改了：重建检测定时器（checkIntervalMs 是唯一的节拍器）
    startTimer();
  }
}

/** 模型选择：插件配置优先，留空跟随"当前对话用的模型"（与 dsh-pet 同一套候选链）。 */
function resolveSelection(ctx, config) {
  if (config.provider && config.model) return { provider: config.provider, model: config.model };
  try {
    const current = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel', false) : null;
    const selection = current?.currentSelection?.();
    if (selection?.provider && selection?.model) return { provider: selection.provider, model: selection.model };
  } catch {
    // 拿不到就走空，由调用方报错
  }
  return { provider: config.provider, model: config.model };
}

/**
 * 按键问答用哪个模型：请求里指定的档位 > 设置里选的档位 > 跟随会话模型。
 * 返回 { selection, preferLocal, key }：
 *   - preferLocal=true 表示"没指定云端模型"，可以走自定义端点一步式抢答；
 *   - 明确选了云端模型时 preferLocal=false，走"识图 + 云端作答"，
 *     否则会出现"选了云端还是本地模型在答"的假开关。
 */
function resolveAskSelection(ctx, config, overrideModel) {
  const key = String(overrideModel || config.askModel || 'follow').trim();
  const preset = ASK_MODEL_PRESETS[key];
  if (preset && preset.provider && preset.model) {
    return { selection: { provider: preset.provider, model: preset.model }, preferLocal: false, key };
  }
  const selection = resolveSelection(ctx, config);
  // 本地 provider（ollama / lmstudio / llama.cpp 之类）也走一步式：
  // 否则"本地识图 + 本地出话"会变成两次本地调用，比一步式还慢。
  const providerName = String(selection.provider ?? '').toLowerCase();
  const isLocalProvider = /qwen|local|ollama|lmstudio|llama/.test(providerName);
  return {
    selection,
    preferLocal: isLocalProvider || !selection.provider || !selection.model || key === 'local',
    key,
  };
}

/**
 * 裁剪外部传来的历史：最多 N 条、总字数不超过 M。
 * 从最新往回保留——"那要几台"这种追问只关心最近两句，早的可以丢。
 */
function normalizeHistory(raw, limit, maxChars) {
  if (!Array.isArray(raw) || limit <= 0) return [];
  const cleaned = [];
  for (const item of raw) {
    const q = typeof item?.q === 'string' ? item.q.trim() : '';
    const a = typeof item?.a === 'string' ? item.a.trim() : '';
    if (q) cleaned.push({ q, a });
  }
  const sliced = cleaned.slice(-limit);
  const kept = [];
  let total = 0;
  const budget = maxChars > 0 ? maxChars : Infinity;
  for (let i = sliced.length - 1; i >= 0; i -= 1) {
    const cost = sliced[i].q.length + sliced[i].a.length;
    if (kept.length > 0 && total + cost > budget) break;
    kept.unshift(sliced[i]);
    total += cost;
  }
  return kept;
}

/** 给前端/设置页的配置视图：apiKey 永远只回"有没有"，绝不回明文。 */
function publicConfig(config) {
  return {
    ...config,
    visionApi: redactVisionApi(config.visionApi),
    // 作答槽的 Key 同样不回明文：用哨兵代替，前端原样回传时会被 /config 识别并保留真值
    askApi: { ...config.askApi, apiKey: config.askApi?.apiKey ? KEEP_API_KEY : '' },
  };
}

// ── 语音试听 ──────────────────────────────────────────────────────────────
// 真正干活的是 runtime/tts/tts_interface.py。插件这边只负责"用当前设置起一个进程"，
// 这样试听听到的就是下一句话会用的声音（音色/语速/音量全都如实传过去）。
const COPILOT_ROOT = process.env.AI_COPILOT_HOME || path.resolve(HERE, '..', '..', '..', 'runtime');

/** 找助理那套 Python 解释器（必须是 python.exe，pythonw 读不到输出）。 */
function copilotPython() {
  const explicit = process.env.AI_COPILOT_PYTHON;
  if (explicit && existsSync(explicit)) return explicit;
  const candidates = [
    path.join(COPILOT_ROOT, 'venv', 'Scripts', 'python.exe'),
    path.join(COPILOT_ROOT, 'venv', 'Scripts', 'python3.exe'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 按当前 tts 设置念一句试听。
 * @returns {Promise<{ok: boolean, message: string, command?: string}>}
 */
async function previewTts({ settings, body }) {
  const python = copilotPython();
  if (!python) {
    return {
      ok: false,
      message: `找不到 Python 解释器（试过 ${path.join(COPILOT_ROOT, 'venv', 'Scripts', 'python.exe')}）。可以用环境变量 AI_COPILOT_PYTHON 指定。`,
    };
  }
  const script = path.join(COPILOT_ROOT, 'tts', 'tts_interface.py');
  if (!existsSync(script)) {
    return { ok: false, message: `找不到 TTS 脚本：${script}` };
  }

  // 试听要用页面当前草稿（未保存的改动也算），不是磁盘上的旧配置。
  // 页面传的是 { text, settings: collect().tts }，这里要拆开合进来。
  const tts = {
    ...(settings.tts ?? {}),
    ...(body && typeof body === 'object' ? body : {}),
    ...(body && body.settings && typeof body.settings === 'object' ? body.settings : {}),
  };
  delete tts.settings; // 嵌套草稿已展开，别把 {settings: {...}} 留在 tts 里
  const text = String(tts.text || '').trim() || '这是一段试听，按住说话现在可以用了。';
  const args = [script, text, '--speak'];
  if (tts.voice) args.push('--voice', String(tts.voice));
  if (Number.isFinite(Number(tts.speed))) args.push('--speed', String(Number(tts.speed)));
  if (Number.isFinite(Number(tts.volume))) args.push('--volume', String(Number(tts.volume)));
  if (tts.backend && tts.backend !== 'auto') args.push('--backend', String(tts.backend));

  return await new Promise((resolve) => {
    let stderr = '';
    let settled = false;
    const child = spawn(python, args, {
      cwd: COPILOT_ROOT,
      // pythonw/窗口进程里起控制台子进程会闪黑框，必须藏起来
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // 杀不掉就算了，反正有超时判定
      }
      done({ ok: false, message: '试听超时（30 秒没播完），可能是网络或后端卡住了' });
    }, 30000);

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      done({ ok: false, message: `起不来：${error.message}` });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        done({ ok: true, message: `已按当前设置念完（${tts.voice || '本地默认音色'} / 语速 ${tts.speed ?? '-'} / 音量 ${tts.volume ?? '-'}）` });
      } else {
        // 把 python 的报错尾巴带出来，否则用户只能看到"失败了"
        const tail = stderr.trim().split('\n').filter(Boolean).slice(-4).join('\n');
        done({ ok: false, message: `试听失败（退出码 ${code}）${tail ? `\n${tail}` : ''}` });
      }
    });
  });
}

/**
 * 体检 TTS 后端，给设置页判断「本地自然人声」这一档能不能选。
 * 跑 tts_interface.py --check --json；native_ready 由 Python 侧算（Edge 桥接不算离线），
 * 这里只负责起进程、收结果、超时保护。
 */
async function probeTts() {
  const python = copilotPython();
  if (!python) return { ok: false, message: '找不到 Python 解释器' };
  const script = path.join(COPILOT_ROOT, 'tts', 'tts_interface.py');
  if (!existsSync(script)) return { ok: false, message: `找不到 TTS 脚本：${script}` };

  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(python, [script, '--check', '--json'], {
      cwd: COPILOT_ROOT,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已经退出了 */ }
      done({ ok: false, message: '体检超时（10 秒）' });
    }, 10000);
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => { clearTimeout(timer); done({ ok: false, message: error.message }); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const tail = stderr.trim().split('\n').filter(Boolean).slice(-3).join('\n');
        done({ ok: false, message: `体检失败（退出码 ${code}）${tail ? `\n${tail}` : ''}` });
        return;
      }
      try {
        const data = JSON.parse(stdout.trim().split('\n').pop() || '{}');
        const native = data.backends?.offline_xiaoxiao || {};
        done({
          ok: true,
          native_ready: Boolean(native.native_ready),
          online: native.online ?? null,
          desc: native.desc || null,
          offline_alt: native.offline_alt || null,
          native_voices: Array.isArray(data.native_voices) ? data.native_voices : [],
          chosen: data.chosen || null,
        });
      } catch (e) {
        done({ ok: false, message: '体检结果解析失败：' + e.message });
      }
    });
  });
}

/** 把用户拖出来的窗口位置落盘（失败无所谓，只是下次位置回到默认）。 */
function savePosition(settings) {
  try {
    void mkdir(path.dirname(POSITION_FILE), { recursive: true }).then(() =>
      writeFile(
        POSITION_FILE,
        JSON.stringify({ x: settings.windowX, y: settings.windowY }, null, 1),
        'utf8',
      ),
    );
  } catch {
    // 存不下不影响运行
  }
}

/** 启动时读回上次的窗口位置（同步读：置顶窗拉起时就要用，不能等异步）。 */
function readPosition() {
  try {
    const parsed = JSON.parse(readFileSync(POSITION_FILE, 'utf8'));
    const x = Number(parsed?.x);
    const y = Number(parsed?.y);
    if (Number.isFinite(x) && Number.isFinite(y)) return { x: Math.round(x), y: Math.round(y) };
  } catch {
    // 没存过就是没有
  }
  return null;
}

/** 置顶小窗那一页（纯静态 HTML）。 */
async function sendOverlayHtml(res) {
  try {
    const html = await readFile(OVERLAY_HTML);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': html.length,
      'cache-control': 'no-store',
    });
    res.end(html);
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`dsh-game-copilot: overlay.html 读不到（${errorText(error)}）`);
  }
}

/** 播一段自带动画：文件名限制成「字母数字下划线短横 + 中文 + .webm」，杜绝路径穿越。 */
async function sendAnimation(res, name) {
  const decoded = decodeURIComponent(name);
  if (!/^[\w\u4e00-\u9fa5-]+\.webm$/.test(decoded)) {
    sendJson(res, 400, { ok: false, reason: 'bad-name' });
    return;
  }
  const file = path.join(ANIMATION_DIR, decoded);
  if (!file.startsWith(ANIMATION_DIR)) {
    sendJson(res, 400, { ok: false, reason: 'bad-name' });
    return;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'content-type': 'video/webm',
      'content-length': info.size,
      'cache-control': 'public, max-age=86400',
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('dsh-game-copilot: no bundled animation');
  }
}

async function readJson(req, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error(`request body too large (${size} > ${limit})`);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

function sendJson(res, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body ?? null), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    ...headers,
  });
  res.end(payload);
}

function errorText(error) {
  if (error && typeof error === 'object' && 'message' in error) return String(error.message);
  return String(error);
}
