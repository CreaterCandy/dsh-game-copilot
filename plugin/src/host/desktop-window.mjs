// desktop-window.mjs —— 把置顶小窗的 Electron 进程管起来。
//
// 只在 Windows/macOS/Linux 有图形界面时有用；找不到 Electron 就**只告警不影响浏览器浮层**
// （和 dsh-pet 同一套容错策略：桌面形态是加分项，不是唯一出路）。
import { existsSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OVERLAY_DIR = path.resolve(HERE, '..', '..', 'runtime', 'overlay');

/** DSH 的 home 目录：DSH_HOME 优先，缺省 ~/.dsh（与 setup.ps1 / ptt_voice.pyw 的口径一致）。 */
export function dshHomeDir() {
  return process.env.DSH_HOME || path.join(homedir(), '.dsh');
}

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
    if (existsSync(explicit)) return { binary: explicit, tried, homeDir: dshHomeDir() };
  }
  // DSH 进程里 DSH_HOME 一般有值；但 setup.ps1 是在普通终端里跑的，那时 DSH_HOME 常为空，
  // 它会装到 %USERPROFILE%\.dsh\electron。所以这里必须用同一个兜底，
  // 否则会出现"安装脚本报告装好了、插件却探测不到"。
  const home = dshHomeDir();
  const candidates = [];
  candidates.push(path.join(home, 'electron', 'electron.exe'));
  candidates.push(path.join(home, 'electron', 'Electron.app', 'Contents', 'MacOS', 'Electron'));
  candidates.push(path.join(home, 'electron', 'electron'));
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
    if (existsSync(candidate)) return { binary: candidate, tried, homeDir: home };
  }
  return { binary: null, tried, homeDir: home };
}

/** 找 Electron 可执行文件：环境变量 → DSH home 下的 electron → LOCALAPPDATA → 本工程 node_modules。 */
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
    // 完整发布包（-full.zip）已经把它打进去了，所以正常用户不该看到这条。
    // 真看到时把"找过哪些路径"全写进日志，再给三条明确出路，照着做就能好。
    log?.(
      'warn',
      `没找到 Electron，置顶小窗跳过（浏览器浮层照常工作）。找过这些位置：${probe.tried.join(' | ')}。` +
        `三种办法：① 换成带 Electron 的完整安装包（Release 里的 -full.zip，自带并会自动装好）；` +
        `② 把一份 Electron 解压到 ${path.join(probe.homeDir, 'electron')}（该目录下要能看到 electron.exe）；` +
        '③ 设环境变量 DSH_GAME_PET_ELECTRON 指向现成的 electron.exe',
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
