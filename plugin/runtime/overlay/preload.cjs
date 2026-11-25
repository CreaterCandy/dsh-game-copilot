// preload.cjs —— 渲染层与宿主唯一的桥梁：只暴露几个开关。
// 用 CJS 是因为 Electron 的 preload 在 contextIsolation 下必须是可 require 的脚本。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gp', {
  /** 鼠标进入/离开宠物命中区时切换"这一块能不能点" */
  setInteractive(value) {
    ipcRenderer.send('gp-set-interactive', Boolean(value));
  },
  /**
   * 上报命中区（相对窗口内容区的 CSS px，{pet:{x,y,w,h}, askbar:同上|null}）。
   * 宿主拿它和系统光标位置比对来判定穿透——**不依赖 mousemove 转发**，因为那套转发
   * 在穿透窗上会彻底失效，失效后窗口永远点不到、拖不动（见 main.mjs 的 hitRects 注释）。
   */
  setHitRects(payload) {
    ipcRenderer.send('gp-hit-rects', payload);
  },
  /**
   * 拖拽三件套：按**屏幕绝对坐标**挪窗。
   * 为什么不用 `-webkit-app-region: drag`：那个要求窗口可聚焦/已聚焦，
   * 而这是 `focusable: false` 的置顶窗，实测按上去没反应。手动拖完全绕开这个限制。
   */
  dragStart(sx, sy) {
    ipcRenderer.send('gp-drag-start', sx, sy);
  },
  /**
   * 拖拽：传当前光标的屏幕绝对坐标（不是增量！）。
   * 宿主端用 窗口 = 按下基准 + (当前 - 按下) 定位，是纯函数，晃动回原点零残差。
   */
  dragMove(sx, sy) {
    ipcRenderer.send('gp-drag-move', sx, sy);
  },
  dragEnd() {
    ipcRenderer.send('gp-drag-end');
  },
  /** 需要程序化移动窗口时用 */
  setPosition(x, y) {
    ipcRenderer.send('gp-set-position', x, y);
  },
  /**
   * 打字输入期间临时把小窗变成可聚焦，让键盘事件能进输入框。
   * 平时仍然是 focusable:false 的穿透窗；输入完立刻收回去。
   */
  inputFocus(active) {
    ipcRenderer.send('gp-input-focus', Boolean(active));
  },
  /** 退出这个小窗 */
  quit() {
    ipcRenderer.send('gp-quit');
  },
});
