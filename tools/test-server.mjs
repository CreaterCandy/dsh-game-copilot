/**
 * 克隆版本地测试服务器（零依赖，纯 node:http）
 *
 * 用途：不装 DSH，就能在浏览器里测 settings.html 的完整交互。
 * 真实现的部分：配置读写、识图探针（填真端点就真发请求）、TTS 离线音色探测、TTS 试听。
 * 模拟的部分：一键启动（真启动需要 setup.ps1 + 常驻守护，测试桩不替你起进程）。
 *
 * 用法：
 *   node tools/test-server.mjs
 *   浏览器打开 http://127.0.0.1:7342/
 *   Ctrl+C 退出。配置写在 config/dsh-game-pet.json，只属于克隆版。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  DEFAULTS,
  ASK_MODEL_PRESETS,
  ASK_BACKEND_PRESETS,
  VISION_MODE_PRESETS,
  TTS_VOICE_PRESETS,
  TTS_BACKEND_PRESETS,
  BUBBLE_STYLE_PRESETS,
  CAPTURE_TARGET_PRESETS,
  normalizeConfig,
  KEEP_API_KEY,
} from '../plugin/src/host/config.mjs';
import { runProbe } from '../plugin/src/host/http-llm.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const HTML = path.join(ROOT, 'settings.html');
const CONFIG = path.join(ROOT, 'config', 'dsh-game-pet.json');
const TTS_DIR = path.join(ROOT, 'runtime', 'tts');
const PORT = Number(process.env.GAMEPET_TEST_PORT || 7342);
const PREFIX = '/dsh-game-pet-7341';

function readUserConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch {
    return {};
  }
}

function writeUserConfig(patch) {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  const merged = { ...readUserConfig(), ...patch };
  const tmp = `${CONFIG}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG);
  return CONFIG;
}

function publicConfig(cfg) {
  const out = { ...cfg };
  if (out.visionApi) out.visionApi = { ...out.visionApi, apiKey: out.visionApi.apiKey ? '••••••••' : '' };
  if (out.askApi) out.askApi = { ...out.askApi, apiKey: out.askApi.apiKey ? '••••••••' : '' };
  return out;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > 512 * 1024) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      try {
        resolve(buf ? JSON.parse(buf) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function findPython() {
  const candidates = [
    path.join(ROOT, 'runtime', 'venv', 'Scripts', 'python.exe'),
    path.resolve(ROOT, '..', 'venv', 'Scripts', 'python.exe'),
    'python',
  ];
  for (const p of candidates) {
    if (p === 'python' || fs.existsSync(p)) return p;
  }
  return null;
}

/** 跑一次 TTS 体检，拿真实的本机离线音色列表。 */
function probeTts() {
  const python = findPython();
  if (!python) return Promise.resolve({ ok: false, message: '找不到 Python，请先跑 setup.ps1' });
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(python, [path.join(TTS_DIR, 'tts_interface.py'), '--check', '--json'], {
      cwd: TTS_DIR,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已退出 */ }
      done({ ok: false, message: 'TTS 体检超时（10 秒）' });
    }, 10000);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return done({ ok: false, message: (stderr || '').slice(0, 200) || `退出码 ${code}` });
      try {
        const d = JSON.parse(stdout);
        done({
          ok: true,
          native_ready: d.backends?.offline_xiaoxiao?.native_ready ?? false,
          native_voices: d.native_voices || [],
          backends: d.backends || {},
          chosen: d.chosen || null,
        });
      } catch (e) {
        done({ ok: false, message: '体检输出解析失败：' + e.message });
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      done({ ok: false, message: e.message });
    });
  });
}

/** 真试听：调用 tts_interface.py 合成并播放一句。 */
function previewTts(settings) {
  const python = findPython();
  if (!python) return Promise.resolve({ ok: false, message: '找不到 Python' });
  const backend = settings && settings.backend;
  const args = [path.join(TTS_DIR, 'tts_interface.py'), '矿机缺煤，把传送带接上就行。', '--speak'];
  if (backend && backend !== 'auto') args.push('--backend', backend);
  return new Promise((resolve) => {
    const child = spawn(python, args, {
      cwd: TTS_DIR,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已退出 */ }
      resolve({ ok: false, message: '试听超时（20 秒）' });
    }, 20000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true } : { ok: false, message: (err || '').slice(-200) || `退出码 ${code}` });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, message: e.message });
    });
  });
}

async function handleApi(req, res, route) {
  // 读配置
  if (req.method === 'GET' && route === '/config') {
    const userConfig = readUserConfig();
    return sendJson(res, 200, {
      ok: true,
      config: publicConfig(normalizeConfig({ ...DEFAULTS, ...userConfig })),
      defaults: DEFAULTS,
      askPresets: ASK_MODEL_PRESETS,
      askBackendPresets: ASK_BACKEND_PRESETS,
      visionModePresets: VISION_MODE_PRESETS,
      ttsVoicePresets: TTS_VOICE_PRESETS,
      ttsBackendPresets: TTS_BACKEND_PRESETS,
      bubbleStylePresets: BUBBLE_STYLE_PRESETS,
      captureTargetPresets: CAPTURE_TARGET_PRESETS,
      userConfig,
    });
  }

  // 保存配置：Key 的 __KEEP__ 哨兵与真实插件一致
  if (req.method === 'POST' && route === '/config') {
    const patch = await readJson(req);
    const accepted = {};
    for (const key of Object.keys(DEFAULTS)) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) accepted[key] = patch[key];
    }
    const oldConfig = normalizeConfig({ ...DEFAULTS, ...readUserConfig() });
    for (const slot of ['visionApi', 'askApi']) {
      if (accepted[slot]?.apiKey === KEEP_API_KEY) {
        accepted[slot] = { ...accepted[slot], apiKey: oldConfig[slot]?.apiKey ?? '' };
      }
    }
    writeUserConfig(accepted);
    const merged = normalizeConfig({ ...DEFAULTS, ...readUserConfig() });
    return sendJson(res, 200, { ok: true, persisted: true, config: publicConfig(merged) });
  }

  // 真探针：填了 baseURL 就真发一张随机数字图
  if (req.method === 'POST' && route === '/vision/probe') {
    const body = await readJson(req);
    const api = body && body.api ? body.api : {};
    if (!api.baseURL) {
      return sendJson(res, 200, {
        status: 'unknown',
        message: '测试桩：没填端点，无法探针。到「模型与能力」填 baseURL 后重试。',
      });
    }
    try {
      const r = await runProbe({ api, timeoutMs: 20000 });
      return sendJson(res, 200, { ...r, testServer: true });
    } catch (e) {
      return sendJson(res, 200, { status: 'unknown', message: e.message });
    }
  }

  if (req.method === 'GET' && route === '/tts/probe') {
    return sendJson(res, 200, await probeTts());
  }

  if (req.method === 'POST' && route === '/tts/preview') {
    const body = await readJson(req);
    return sendJson(res, 200, await previewTts(body && body.settings));
  }

  // 一键启动在测试桩里不真起进程——真启动见 README「三步上手」
  if (req.method === 'POST' && route === '/runtime/start') {
    return sendJson(res, 200, {
      ok: false,
      message: '测试模式不启动守护进程。先跑 setup.ps1，再用 start_copilot.cmd 启动。',
    });
  }

  if (req.method === 'GET' && route === '/runtime/status') {
    return sendJson(res, 200, { running: false, testServer: true });
  }

  // 对话日志/排障：与真插件同契约（脱敏、GBK、倒序、tail）
  if (req.method === 'GET' && route === '/logs') {
    const query = new URL(req.url, `http://127.0.0.1:${PORT}`).searchParams;
    const home = process.env.DSH_HOME || os.homedir();
    const sources = {
      copilot: { label: '主对话日志', file: path.join(ROOT, 'runtime', 'copilot_log.jsonl'), jsonl: true },
      bridge: { label: '播报桥日志', file: path.join(ROOT, 'runtime', 'pet_bridge_log.jsonl'), jsonl: true },
      runtime: { label: '按键守护输出', file: path.join(home, 'dsh-game-pet-runtime.log'), gbk: true },
      bridgeout: { label: '播报桥输出', file: path.join(home, 'dsh-game-pet-bridge.log'), gbk: true },
    };
    const key = query.get('source') || 'copilot';
    const src = sources[key];
    if (!src) return sendJson(res, 200, { ok: false, message: '未知日志源' });
    const tail = Math.max(1, Math.min(500, Number(query.get('tail')) || 120));
    const plain = query.get('plain') === '1';
    const exists = fs.existsSync(src.file);
    let text = '';
    if (exists) {
      const buf = fs.readFileSync(src.file);
      text = src.gbk ? new TextDecoder('gbk').decode(buf) : buf.toString('utf8');
    }
    const allLines = text.split(/\r?\n/).filter(Boolean);
    const sliced = allLines.slice(-tail);
    let rows = sliced.map((line) => {
      if (src.jsonl) {
        try {
          const row = JSON.parse(line);
          if (!plain) {
            for (const k of ['question', 'answer', 'reasoning']) {
              if (row[k]) row[k] = '••••（已隐藏，勾选「显示原文」查看）';
            }
          }
          return row;
        } catch {
          return { at: '', kind: 'raw', raw: line.slice(0, 500) };
        }
      }
      return {
        at: '', kind: 'text',
        text: plain ? line : line.replace(/^(识别|回答|出错)[：:]/, (m) => m + '••••（已隐藏，勾选「显示原文」查看）'),
      };
    }).reverse();
    return sendJson(res, 200, {
      ok: true, source: key, label: src.label, file: src.file, exists,
      bytes: exists ? fs.statSync(src.file).size : 0, shown: rows.length,
      totalLines: allLines.length, truncated: allLines.length > sliced.length, rows,
    });
  }

  return sendJson(res, 404, { ok: false, message: `测试桩未实现：${req.method} ${route}` });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname === '/' || url.pathname === '/settings.html') {
      const html = fs.readFileSync(HTML);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (url.pathname.startsWith(PREFIX)) {
      return await handleApi(req, res, url.pathname.slice(PREFIX.length));
    }
    return sendJson(res, 404, { ok: false, message: 'not found' });
  } catch (e) {
    return sendJson(res, 500, { ok: false, message: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`克隆版测试服务器已启动：http://127.0.0.1:${PORT}/`);
  console.log(`配置文件：${CONFIG}`);
  console.log('Ctrl+C 退出。一键启动为模拟接口，其余探测为真实现。');
});
