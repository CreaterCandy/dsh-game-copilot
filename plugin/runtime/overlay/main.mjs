// main.mjs —— 桌宠浮层的「置顶小窗」宿主（极简 Electron 主进程）。
//
// 为什么需要它：浏览器里的浮层只能活在 DSH 窗口内，永远盖不到别的应用上面。
// 要让建议在玩游戏时真的看得见，必须开一个**透明、置顶、跳过任务栏**的小窗。
//
// 交互约定（与 dsh-pet 同一套思路）：
//   - 窗内只有"宠物身体命中区"可交互，其余透明像素一律点击穿透到下层应用；
//   - 默认 ignoreMouseEvents(true, {forward:true})：保留 mousemove 才能判断悬停；
//   - 渲染层检测到鼠标进入命中区 → 调 preload 暴露的 setInteractive(true) 翻成可交互；
//   - 拖拽：渲染层用 PointerEvent 上报光标的屏幕绝对坐标，主进程按
//     窗口 = 按下基准 + (当前 - 按下) 做纯函数定位（带死区与 warp 平移基准），
//     晃动回原点零残差；松手后把坐标回传宿主保存。
//
// 环境变量（由宿主半侧注入）：
//   GP_OVERLAY_URL  要加载的页面（宿主自己的 /overlay 路由）
//   GP_POS_URL      回传窗口坐标的接口（宿主 /position）
//   GP_PING_URL     存活探测接口（宿主 /ping）；探测失败即自行退出，不留孤儿窗
//   GP_X / GP_Y     窗口左上角坐标（虚拟屏坐标；缺省则右下角）
import { app, BrowserWindow, ipcMain, screen } from 'electron';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 小窗是独立进程，stdout 常常看不到；所以出错一律落盘一份，排障全靠它。 */
function trace(line) {
  try {
    const file = process.env.GP_LOG_FILE;
    if (!file) return;
    appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch {
    // 日志失败不影响窗口
  }
}

process.on('uncaughtException', (error) => {
  trace(`uncaughtException: ${error?.stack ?? error}`);
});
process.on('unhandledRejection', (reason) => {
  trace(`unhandledRejection: ${reason?.stack ?? reason}`);
});

// 必须在 ready 之前调用（ready 之后调会抛）
app.disableHardwareAcceleration?.();

const url = process.env.GP_OVERLAY_URL;
const posUrl = process.env.GP_POS_URL;
const pingUrl = process.env.GP_PING_URL;
const width = Number(process.env.GP_WIDTH || 340);
const height = Number(process.env.GP_HEIGHT || 360);
const wantX = process.env.GP_X ? Number(process.env.GP_X) : null;
const wantY = process.env.GP_Y ? Number(process.env.GP_Y) : null;

trace(`boot pid=${process.pid} url=${url} size=${width}x${height} at=${wantX},${wantY}`);

if (!url) {
  trace('GP_OVERLAY_URL missing, exiting');
  console.error('dsh-game-pet overlay: GP_OVERLAY_URL is required');
  app.exit(2);
}

let win = null;
let interactive = false;
let moveTimer = null;
/**
 * 拖拽基准（**绝对定位**，不是增量累加）：
 *   winX/winY      —— 按下瞬间的窗口左上角
 *   screenX/screenY —— 按下瞬间的光标屏幕坐标
 *   lastSX/lastSY  —— 上一帧光标屏幕坐标，仅用于识别 warp 跳变
 *
 * 为什么不用"每帧增量累加"：那是 window += Σ(prev-current)。任何一帧读数残差、
 * 事件重复/漏报、pointerup 尾段补发都会永久留在累加值里出不来，晃一圈鼠标回原点
 * 窗口却回不去——表现就是"不管怎么晃，窗口只往右/下单向偏移"（实测用户症状）。
 * 绝对定位是纯函数 window = winAtPress + (cursor - cursorAtPress)：
 * 光标回到按下点，窗口必然精确回到原位，零累积误差；甩多快都全量跟随，无阈值可误杀。
 */
let dragBase = null;
/**
 * 窗口外框尺寸（在 createWindow 后固定下来）。
 *
 * ⚠️ 2026-11-25 实测根因：Electron 20 + Windows 的**透明无边框窗**每调用一次
 * `win.setPosition()`，bounds 宽高都会悄悄 +~1.3px（隔离实验：60 帧 344→424）。
 * 用户一拖就是几百帧，窗口膨胀到 1200+px，宠物在里面越缩越偏、看起来就是
 * “长按往下掉”。绝对定位算得再对也没用——尺寸在被系统偷偷改。
 * 解法：所有挪窗一律走 `setBounds()` 并显式带上固定宽高，绝不单独 setPosition。
 * 实测 setBounds 60 帧尺寸恒定（344 ↔ 345 的 1px 对齐波动，不再累积）。
 */
let winBoundsSize = null;
/**
 * warp 闸门：单帧跳变超过这个值（远超任何屏幕宽度）视为坐标异常/系统 warp 光标，
 * 处理方式是**平移基准**而不是丢弃位移或钳制——窗口停住、基准跟到新坐标，
 * 后续照常绝对定位。这样既不会把光标瞬移画到窗口上，也不会累加出残差。
 */
const DRAG_WARP = 3000;
/** 相对按下点位移小于这个值视为手抖（像素）：长按不动时窗口纹丝不动 */
const DRAG_DEADZONE = 2;

function defaultPosition() {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(area.x + area.width - width - 24),
    y: Math.round(area.y + area.height - height - 24),
  };
}

/**
 * 把坐标夹回"看得见的地方"。
 *
 * 为什么必须夹：坐标是用户拖拽后存下来的，而显示器拓扑会变（拔掉副屏、改分辨率、
 * 缩放调整）。存下来的 -922 这种值在当时的布局里合法，换个布局就整窗飘到屏幕外，
 * 表现是"桌宠不见了"——进程还在、窗口还 alive，就是没人看得见（2026-11-24 踩过）。
 * 规则：窗口和任意一块屏幕的工作区有 40×40 以上的交集就算可见，否则回默认角落。
 */
function visiblePosition(x, y) {
  const nx = Number(x);
  const ny = Number(y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return defaultPosition();
  const MIN = 40;
  for (const display of screen.getAllDisplays()) {
    const area = display.workArea;
    const overlapX = Math.min(nx + width, area.x + area.width) - Math.max(nx, area.x);
    const overlapY = Math.min(ny + height, area.y + area.height) - Math.max(ny, area.y);
    if (overlapX >= MIN && overlapY >= MIN) return { x: Math.round(nx), y: Math.round(ny) };
  }
  const fallback = defaultPosition();
  trace(`position ${nx},${ny} is off every display -> fallback ${fallback.x},${fallback.y}`);
  return fallback;
}

async function post(url, body) {
  if (!url) return false;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function createWindow() {
  const fallback = defaultPosition();
  const spot = visiblePosition(wantX ?? fallback.x, wantY ?? fallback.y);
  try {
    win = new BrowserWindow({
      width,
      height,
      x: spot.x,
      y: spot.y,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      focusable: false,
      show: false,
      webPreferences: {
        preload: path.join(path.dirname(fileURLToPath(import.meta.url)), 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
  } catch (error) {
    trace(`BrowserWindow creation failed: ${error?.stack ?? error}`);
    return null;
  }

  trace('BrowserWindow created');
  const initialBounds = win.getBounds();
  winBoundsSize = { width: initialBounds.width, height: initialBounds.height };
  trace(`initial bounds ${JSON.stringify(initialBounds)}`);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.webContents.on('did-fail-load', (_event, code, description, validatedUrl) => {
    trace(`did-fail-load code=${code} ${description} url=${validatedUrl}`);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    trace(`render-process-gone ${JSON.stringify(details)}`);
  });
  win.webContents.on('console-message', (_event, level, message) => {
    trace(`renderer console[${level}]: ${message}`);
  });
  void win.loadURL(url).then(
    () => {
      trace('loadURL resolved');
      // 诊断：页面加载完再等 2.5 秒，把 video / root 的真实状态打一行出来。
      // 排障用（"窗口在、但画面空白"时靠这行分辨是素材没加载还是窗口不可见）。
      setTimeout(() => {
        win?.webContents
          .executeJavaScript(`(() => {
            const v = document.getElementById('video');
            const r = document.getElementById('root');
            const p = document.getElementById('pet');
            const rect = v && v.getBoundingClientRect ? v.getBoundingClientRect() : null;
            return JSON.stringify({
              rootHidden: r ? r.hidden : null,
              rootOpacity: r ? getComputedStyle(r).opacity : null,
              videoDisplay: v ? getComputedStyle(v).display : null,
              videoSrc: v ? String(v.currentSrc || v.src || '') : null,
              readyState: v ? v.readyState : null,
              paused: v ? v.paused : null,
              error: v && v.error ? v.error.code + ':' + v.error.message : null,
              videoSize: v ? [v.videoWidth, v.videoHeight] : null,
              rect: rect ? [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)] : null,
              petKids: p ? p.children.length : null,
              winSize: [window.innerWidth, window.innerHeight],
            });
          })()`)
          .then(
            (info) => trace(`page-probe ${info}`),
            (err) => trace(`page-probe failed: ${err?.message ?? err}`),
          );
      }, 2500);
    },
    (error) => trace(`loadURL rejected: ${error?.message ?? error}`),
  );
  win.once('ready-to-show', () => {
    win?.showInactive();
    trace('ready-to-show -> showInactive');
  });
  if (process.env.GP_SHOW === '1') {
    win.showInactive();
    trace('GP_SHOW=1 -> showInactive immediately');
  }

  win.on('moved', () => {
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      if (!win) return;
      const [x, y] = win.getPosition();
      trace(`moved -> ${x},${y}`);
      void post(posUrl, { x, y });
    }, 400);
  });

  win.on('closed', () => {
    trace('window closed');
    win = null;
  });
  return win;
}

/**
 * 挪窗统一入口：**必须带固定宽高**。
 * 只调 setPosition 会让 Electron 透明无边框窗每帧膨胀 ~1.3px（见 winBoundsSize 注释），
 * 所以任何位置变更都走 setBounds，把 createWindow 时记下的外框尺寸原样带上。
 */
function placeWindow(x, y) {
  if (!win) return;
  const w = winBoundsSize?.width;
  const h = winBoundsSize?.height;
  if (!w || !h) {
    win.setPosition(Math.round(x), Math.round(y));
    return;
  }
  win.setBounds({ x: Math.round(x), y: Math.round(y), width: w, height: h });
}

/**
 * 拖拽：**不用** `-webkit-app-region: drag`（那个要求窗口可聚焦/已聚焦，本窗是
 * `focusable: false` 的置顶窗，实测点了没反应），改成渲染层报**光标的屏幕绝对坐标**、
 * 这里做纯函数定位——完全不依赖 OSC 拖拽区域与焦点，也不读全局光标。
 */
function startDrag(sx, sy) {
  if (!win) return;
  const b = win.getBounds();
  const px = Number(sx);
  const py = Number(sy);
  // 首帧坐标可能缺失/非法，moveDrag 会用第一帧补种基准
  dragBase = {
    winX: b.x,
    winY: b.y,
    screenX: Number.isFinite(px) ? px : null,
    screenY: Number.isFinite(py) ? py : null,
    lastSX: Number.isFinite(px) ? px : null,
    lastSY: Number.isFinite(py) ? py : null,
    lastTraceAt: 0,
  };
  trace(`drag start at ${sx},${sy} window ${b.x},${b.y} size ${b.width}x${b.height}`);
}

/**
 * 绝对定位：窗口 = 按下时窗口位置 + (当前光标屏幕坐标 - 按下时光标屏幕坐标)。
 *
 * 这是纯函数——同一光标位置永远映射到同一窗口位置，与中间发生过什么无关。
 * 所以：晃一圈回原点 = 精确回原位（零累积）；甩多快都全量跟随（无丢弃阈值）；
 * 长按不动光标微抖 → 死区挡住；系统 warp 光标 → 平移基准、窗口不跟着跳。
 */
function moveDrag(sx, sy) {
  if (!win || !dragBase) return;
  const px = Number(sx);
  const py = Number(sy);
  if (!Number.isFinite(px) || !Number.isFinite(py)) return;

  // 首帧补种基准（pointerdown 没带到坐标时的兜底）
  if (dragBase.screenX === null) {
    dragBase.screenX = px;
    dragBase.screenY = py;
    dragBase.lastSX = px;
    dragBase.lastSY = py;
    return;
  }

  // warp 闸门：单帧跳变超过屏宽 = 坐标异常/系统瞬移光标。平移基准让窗口停在原地，
  // 而不是把这次跳变算进位移（那样窗口会突然飞走），也不是丢弃（那样会留残差）。
  const jumpX = px - dragBase.lastSX;
  const jumpY = py - dragBase.lastSY;
  dragBase.lastSX = px;
  dragBase.lastSY = py;
  if (Math.abs(jumpX) > DRAG_WARP || Math.abs(jumpY) > DRAG_WARP) {
    dragBase.screenX += jumpX;
    dragBase.screenY += jumpY;
    trace(`drag warp rebase ${jumpX},${jumpY}`);
    return;
  }

  // 纯函数绝对定位：不读全局光标、不累加任何历史量
  const offX = px - dragBase.screenX;
  const offY = py - dragBase.screenY;
  // 死区只在"窗口也确实停在基准附近"时生效（长按手抖：光标和窗口都没离开）；
  // 若窗口已被拖离、光标正回程落到死区内，仍要 setPosition 回原位，否则晃一圈
  // 回原点会留下 1~2px 残差——那正是"晃完偏一点"的缩小版，不能留。
  if (Math.abs(offX) < DRAG_DEADZONE && Math.abs(offY) < DRAG_DEADZONE) {
    const [curX, curY] = win.getPosition();
    if (Math.abs(curX - dragBase.winX) < DRAG_DEADZONE &&
        Math.abs(curY - dragBase.winY) < DRAG_DEADZONE) return;
  }
  const targetX = dragBase.winX + offX;
  const targetY = dragBase.winY + offY;
  placeWindow(targetX, targetY);
  // 节流记录真实坐标与外框：以后再出现“拖着拖着尺寸/位置不对”，日志能一眼看穿
  const now = Date.now();
  if (now - dragBase.lastTraceAt >= 400) {
    dragBase.lastTraceAt = now;
    const b = win.getBounds();
    trace(`drag move cursor ${px},${py} off ${offX},${offY} bounds ${b.x},${b.y} ${b.width}x${b.height}`);
  }
}

function endDrag() {
  if (!win || !dragBase) return;
  dragBase = null;
  const [x, y] = win.getPosition();
  trace(`drag end -> ${x},${y}`);
  void post(posUrl, { x, y });
}

app.whenReady().then(
  () => {
    trace('app ready');
    createWindow();

    ipcMain.on('gp-set-interactive', (_event, value) => {
      const next = Boolean(value);
      if (next === interactive) return;
      interactive = next;
      win?.setIgnoreMouseEvents(!next, { forward: true });
    });

    ipcMain.on('gp-set-position', (_event, x, y) => {
      placeWindow(Number(x) || 0, Number(y) || 0);
    });

    ipcMain.on('gp-drag-start', (_event, sx, sy) => startDrag(sx, sy));
    ipcMain.on('gp-drag-move', (_event, sx, sy) => moveDrag(sx, sy));
    ipcMain.on('gp-drag-end', () => endDrag());

    ipcMain.on('gp-quit', () => app.quit());

    // 宿主不在了就退出（每 15 秒探一次）；顺便把窗口状态记一行，排障用
    setInterval(() => {
      void (async () => {
        if (win) {
          trace(
            `state alive=${win.isVisible()} bounds=${JSON.stringify(win.getBounds())} onScreen=${win.isOnScreen?.()}`,
          );
        }
        const alive = await post(pingUrl, { pid: process.pid });
        if (!alive) app.quit();
      })();
    }, 15000);
  },
  (error) => trace(`app.whenReady rejected: ${error?.stack ?? error}`),
);

app.on('window-all-closed', () => app.quit());
