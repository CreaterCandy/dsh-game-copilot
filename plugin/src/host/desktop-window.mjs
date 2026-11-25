// desktop-window.mjs —— 把置顶小窗的 Electron 进程管起来。
//
// 只在 Windows/macOS/Linux 有图形界面时有用；找不到 Electron 就**只告警不影响浏览器浮层**
// （和 dsh-pet 同一套容错策略：桌面形态是加分项，不是唯一出路）。
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OVERLAY_DIR = path.resolve(HERE, '..', '..', 'runtime', 'overlay');

/**
 * 探测 Electron，并把"找过哪些路径"一起返回。
 * 分开返回 tried 是为了排障：用户报"小窗起不来"时，日志能直接看出到底缺在哪，
 * 不用猜是没装、装错地方、还是环境变量写歪了。
 */
export function electronProbe() {
  const tried = [];
  const explicit = process.env.DSH_GAME_PET_ELECTRON || process.env.DSH_PET_ELECTRON_PATH;
  if (explicit) {
    tried.push(explicit);
    if (existsSync(explicit)) return { binary: explicit, tried };
  }
  const home = process.env.DSH_HOME;
  const candidates = [];
  if (home) {
    candidates.push(path.join(home, 'electron', 'electron.exe'));
    candidates.push(path.join(home, 'electron', 'Electron.app', 'Contents', 'MacOS', 'Electron'));
    candidates.push(path.join(home, 'electron', 'electron'));
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'electron', 'electron.exe'));
    // npm i -g electron 的常见落点（有些用户就是这么装的）
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'electron', 'electron.exe'));
  }
  // 工程内 `npm i electron`：源码布局与打包布局各算一层
  candidates.push(path.resolve(HERE, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe'));
  candidates.push(path.resolve(HERE, '..', '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe'));
  for (const candidate of candidates) {
    tried.push(candidate);
    if (existsSync(candidate)) return { binary: candidate, tried };
  }
  return { binary: null, tried };
}

/** 找 Electron 可执行文件：环境变量 → DSH 自己下载的那份（dsh-pet 用的也是这个）→ 本工程 node_modules。 */
function electronBinary() {
  return electronProbe().binary;
}

/**
 * 起一个小窗进程。
 * @param {{ host: string, port: number, width?: number, height?: number, x?: number|null, y?: number|null,
 *   onPosition?: (x: number, y: number) => void, log?: (level: string, message: string) => void }} options
 * @returns {{ stop: () => void, running: () => boolean }}
 */
export function startOverlayWindow(options) {
  const { host = '127.0.0.1', port, width = 340, height = 360, x = null, y = null, hidden = false, log } = options;
  const probe = electronProbe();
  const binary = probe.binary;
  if (!binary) {
    // 不静默下载：Electron 一百多兆，静默拉包在被墙/断网时只会更糟。
    // 把"找过哪些路径"全写进日志，再给两条明确出路，用户照着做就能好。
    log?.(
      'warn',
      `没找到 Electron，置顶小窗跳过（浏览器浮层照常工作）。找过这些位置：${probe.tried.join(' | ')}。` +
        '两种办法：① 让 DSH 自己下（首次开桌宠会下到 %DSH_HOME%\\electron）；' +
        '② 设环境变量 DSH_GAME_PET_ELECTRON 指向你的 electron.exe',
    );
    return { stop: () => {}, running: () => false };
  }
  if (!existsSync(path.join(OVERLAY_DIR, 'main.mjs'))) {
    log?.('warn', `置顶小窗的宿主文件缺失：${OVERLAY_DIR}`);
    return { stop: () => {}, running: () => false };
  }

  const base = `http://${host}:${port}/dsh-game-copilot-7341`;
  const env = {
    ...process.env,
    GP_OVERLAY_URL: `${base}/overlay`,
    GP_POS_URL: `${base}/position`,
    GP_PING_URL: `${base}/ping`,
    GP_WIDTH: String(width),
    GP_HEIGHT: String(height),
    // 上次收起过就直接不显示，别先闪一下再消失
    GP_HIDDEN: hidden ? '1' : '0',
    GP_LOG_FILE: path.join(process.env.DSH_HOME || process.env.TEMP || '.', 'dsh-game-copilot-window.log'),
  };
  if (x !== null && x !== undefined) env.GP_X = String(x);
  if (y !== null && y !== undefined) env.GP_Y = String(y);
  delete env.ELECTRON_RUN_AS_NODE;

  let child = null;
  let stopped = false;

  const launch = () => {
    if (stopped) return;
    child = spawn(binary, [path.join(OVERLAY_DIR, 'main.mjs')], {
      env,
      stdio: 'ignore',
      windowsHide: true,
      detached: false,
    });
    child.on('exit', (code) => {
      child = null;
      if (stopped) return;
      log?.('warn', `置顶小窗退出（code=${code}），2 秒后重新拉起`);
      setTimeout(launch, 2000);
    });
    child.on('error', (error) => {
      log?.('warn', `置顶小窗启动失败：${error.message}`);
    });
  };

  launch();

  return {
    stop() {
      stopped = true;
      try {
        child?.kill();
      } catch {
        // 退出失败无所谓，宿主进程结束时它会因为 ping 失败自己退
      }
      child = null;
    },
    running: () => child !== null,
  };
}

export { electronBinary };
