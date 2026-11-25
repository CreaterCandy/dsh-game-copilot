// config.mjs —— 插件配置的形状、默认值与容错归一化。
//
// 配置活在 cordis.patch.yml 的 row config 里（用户那份 patch 层在升级后依然保留），
// 所以这里只做「缺省回落 + 类型纠偏」，绝不因为一个字段写错就让插件装不上。

export const DEFAULTS = {
  /** 总开关：关掉就不探窗口、不截屏、不调模型 */
  enabled: true,
  /** 游戏白名单：进程名（可带/不带 .exe，大小写不敏感）或窗口标题关键字。
   *  空数组 = 任何前台窗口都算（连看视频也会跟你唠，慎用）。 */
  games: [],
  /** 全屏游戏才发言？false = 窗口化 / 无边框也算 */
  requireFullscreen: false,
  /** 前台窗口最小化的（比如切回桌面）不算在玩游戏 */
  ignoreMinimized: true,
  /** 多久看一眼游戏（毫秒）——检测很便宜（一次 PowerShell 调用），默认 5 秒 */
  checkIntervalMs: 5000,
  /** 多久说一句话（毫秒），默认 45 秒。这就是"自动"的节奏，也是花钱的节奏 */
  intervalSec: 45,
  /** 一段话最少持续多久才允许下一句（毫秒） */
  minGapMs: 8000,
  /** 一段时间不说话（毫秒）之后，下次开口先重新"看"一眼画面。
   *  默认 0 = 每句都重新截屏看图（最准也最贵）。 */
  snapshotTtlMs: 0,
  /** 单次生成超时（毫秒） */
  timeoutMs: 45000,
  /** 截图范围：auto(游戏/前台窗口优先，没有就主屏) | window | primary | secondary | all */
  captureTarget: 'auto',
  /** 旧字段，只为兼容老配置：captureTarget 没写时按它推 —— true→all(拼接)，false→auto */
  captureFullScreen: false,
  /** 最多回传多少张截图当"最近画面"上下文（0 = 不回溯） */
  historyLimit: 6,
  /** 看图/出主意用的模型；留空 = 跟随当前对话用的模型 */
  provider: '',
  model: '',
  /** 识图那一步用的模型（把截图转成文字描述）。留空 = 自动探测：先试 dsh-vision-router 的
   *  直连视觉路由 vision-http，再找注册表里声明支持图片输入的模型。
   *  ⚠️ 别填 `deepseek-vision` 这类"自动识图包装"：那类包装是靠让模型发起识图工具调用来工作的，
   *  插件直接把图塞给它，模型会把工具调用标记当正文吐出来（气泡里就出现"代码"）。 */
  visionProvider: '',
  visionModel: '',
  /** 自己填一个视觉模型 API（OpenAI / Anthropic 兼容）当识图后端。
   *  填了且 enabled 就**排在最前面**用，探测不到注册表模型时这是唯一的出路。
   *  apiKey 以明文存在 $DSH_HOME/dsh-game-copilot.json（本机文件），界面只回"有没有"。 */
  visionApi: {
    enabled: false,
    baseURL: '',
    model: '',
    apiKey: '',
    /** 'openai' = POST <base>/chat/completions；'anthropic' = POST <base>/v1/messages */
    format: 'openai',
    maxTokens: 1024,
  },
  /** 浮层形态：'window' = 独立透明置顶小窗（能盖在别的应用上层、可拖动）；'browser' = 只画在 DSH 网页里 */
  overlay: 'window',
  /** 置顶小窗位置（虚拟屏坐标，左上角）；null = 自动放在主屏右下角 */
  windowX: null,
  windowY: null,
  /** 人设：决定它怎么说话 */
  persona: '',
  /** 已经玩多久之后才开口（毫秒）——刚开游戏别急着插嘴 */
  warmupMs: 15000,

  // ── 按键问答（把本插件当"助理外壳"用）────────────────────────────────
  /** 允许外部 POST /ask 把「问题 + 截图」送进来（Python 按键脚本用）。关掉就只当桌宠 */
  askEnabled: true,
  /** 回答用哪个模型档：'follow' = 跟随下面的 provider/model；其余见 ASK_MODEL_PRESETS */
  askModel: 'follow',
  /** 回答输出上限（token）。太小会答一半，太大会拖慢 */
  askMaxTokens: 512,
  /** 记忆：一次最多注入几条历史（0 = 完全不带记忆） */
  memoryLimit: 3,
  /** 记忆：注入内容的总字数上限（防止把 prompt 撑爆、prefill 变慢） */
  memoryChars: 1500,
  /** 助理人设（留空用内置那套：完整句 / 算数只给结论 / 禁 Markdown） */
  askPersona: '',
  /** 一步式：把截图**直接**交给回答模型（少一次识图往返）。
   *  默认开——主流多模态模型都能直接看图，实测能准确描述屏幕内容。
   *  前提：① 所用端点支持图片输入；② 走 DSH 通道时附件服务可用。
   *  任一条不满足会自动退回"识图端 + 云端作答"两步式，不会哑火。
   *  两步式依赖单独的识图服务，免费的匿名端点常有 IP 限流，
   *  限流时识图失败会导致模型误答"看不到画面"——所以优先一步式。 */
  askOneShot: true,

  // ── 模型接入槽位（本项目核心：本地 / 云端一个填法）────────────────
  /** 作答后端：'http' = 任意 OpenAI/Anthropic 兼容端点；'dsh' = DSH 会话模型（高级折叠，可选） */
  askBackend: 'http',
  /** 作答槽。和 visionApi 分开：可以"便宜文本模型作答 + 本地识图模型看图" */
  askApi: {
    enabled: true,
    baseURL: '',
    model: '',
    apiKey: '',
    format: 'openai',
    maxTokens: 512,
    /** 作答端自己能不能看图：auto = 跑一次数字探针自动判；yes/no = 手动覆盖 */
    vision: 'auto',
  },
  /** 数字探针结果（只由 /vision/probe 写，用户也可用 askApi.vision 手动覆盖） */
  visionProbe: {
    status: 'unknown', // unknown | yes | no
    checkedAt: 0,
  },

  /** 气泡顶部回显"我这句话被识别成了什么"。
   *  ASR 听错时（"除以3" → "除13"）一眼能看出是没听清还是答错了，排查必开。 */
  echoQuestion: true,

  /** 记忆模式：'off' = 完全不带历史；'auto' = 只有像追问（那/这个/刚才/继续）才翻；
   *  'always' = 每次带上最相关的几条。条数与字数上限见 memoryLimit / memoryChars。 */
  memoryMode: 'auto',

  /** 热键：ptt 与附加热键共用同一份配置（§13.13/13.14）。
   *  实际注册在 Python 侧；插件只负责存与校验，extra.*.enabled=false 表示整条不注册。 */
  hotkeys: {
    ptt: 'capslock',
    extra: {
      askScreen: { enabled: true, key: 'ctrl+alt+q' },
      speakClipboard: { enabled: true, key: 'ctrl+alt+w' },
      exit: { enabled: true, key: 'ctrl+alt+shift+q' },
      toggleWindow: { enabled: true, key: 'ctrl+alt+h' },
      typeQuestion: { enabled: true, key: 'ctrl+alt+t' },
    },
  },

  /** 置顶小窗尺寸（逻辑像素，受系统缩放影响）。改完要重启桌面应用。 */
  windowWidth: 340,
  windowHeight: 360,

  /** 气泡外观：classic（暗色圆角，默认）/ comic（白底黑边漫画框）/ glass（毛玻璃）/
   *  hud（游戏 HUD 青色描边）/ plain（无底色纯字）。两个形态（小窗、应用内）共用。 */
  bubbleStyle: 'classic',
  /** 气泡字号（px）。长回答行数多时可以调小一点 */
  bubbleFontSize: 13,
  /** 气泡最大宽度（px）。小窗里仍受窗口宽度约束；应用内浮层用它控制"一行多长" */
  bubbleMaxWidth: 300,

  // ── 语音播报（真正干活的在 runtime/tts/tts_interface.py）────────────
  // 这一组只存配置：ptt_voice 每次合成前读 %DSH_HOME%\dsh-game-copilot.json 的 tts 段，
  // 所以这里改完**下一句话就生效**，不用重启播报进程。
  tts: {
    /** 关掉 = 只显示气泡不出声 */
    enabled: true,
    /** 语音引擎：'auto' 按降级链（Edge→系统语音），也可锁定本地自然人声（需自行装语音包） */
    backend: 'auto',
    /** 音色（SAPI token，如 Xiaoyi / 云希）。留空 = 沿用 tts/config.json 里的 */
    voice: '',
    /** 语速：SAPI 整数 -10..10，0 原速，1 ≈ 1.20x（实测） */
    speed: 1,
    /** 音量 0..100（SAPI 会烘进波形，winsound 播出来也生效） */
    volume: 100,
    /** 分句流式：第一句合成完就开口（关掉 = 整句合成后一次播） */
    streaming: true,
    /** 分句后单句最长字数（太长会一口气念很久，太短会碎） */
    maxChars: 60,
  },
};

/**
 * 设置页「语音引擎」下拉的数据源。
 * auto = 交给 tts/config.json 的 auto_order 降级链（推荐）。
 */
// 本项目三档：Edge 在线 / Windows 系统语音 / 本地自然人声（可选）。
// 第三档不预置、不默认、不随包分发：微软自然人声有第三方许可，只能用户自己装；
// 设置页会先调 /tts/probe，只有探测到真离线音色才提示「本机可用」（§13.17）。
export const TTS_BACKEND_PRESETS = {
  auto: '自动（Edge 在线 → 系统语音，断网也能念）',
  edge_tts: 'Edge 在线（音色最全，需要联网）',
  sapi_fallback: 'Windows 系统语音（断网可用，机械音）',
  offline_xiaoxiao: '本地自然人声（需自行装语音包，断网可用）',
};

/**
 * 设置页「语音人」下拉的数据源。
 * token 与 `tts_interface.ALIASES` / `EDGE_VOICE_BY_TOKEN` 一一对应，
 * 改这里要同步那两个表（Python 侧靠 token 推 Edge 全名）。
 * 发行版不写死"哪个音色在本机离线"——那是每台机器自己的状态，
 * 由设置页的 /tts/probe 现场探测并展示。
 */
export const TTS_VOICE_PRESETS = [
  { token: 'Xiaoyi', label: '晓伊（少女音）', online: null },
  { token: 'Xiaoxiao', label: '晓晓（女声）', online: null },
  { token: 'Huihui', label: '慧慧（老式离线机械音）', online: false },
  { token: 'Yunjian', label: '云健（男声·播报腔）', online: true },
  { token: 'Yunxi', label: '云希（男声·年轻）', online: true },
  { token: 'Yunxia', label: '云霞（男童）', online: true },
  { token: 'Yunyang', label: '云扬（男声·新闻腔）', online: true },
  { token: 'Xiaobei', label: '晓北（东北话）', online: true },
  { token: 'Xiaoni', label: '晓妮（陕西话）', online: true },
];

/**
 * 按键问答的模型档位（设置页下拉框的数据源）。
 * 改这里就等于改设置页能选什么——不用动前端。
 * `provider`/`model` 为空表示"不覆盖"，交给 resolveAskSelection 回落到会话模型。
 */
export const ASK_MODEL_PRESETS = {
  follow: { label: '跟随当前对话的模型', provider: '', model: '' },
  local: { label: '本地模型（由端点决定）', provider: '', model: '' },
  /** 推荐：填自己的端点，Ollama / LM Studio / 云端 API 都是这一种填法 */
  custom: { label: '自定义端点（本地或云端，同一个填法）', provider: '', model: '' },
};

/** 作答后端下拉。dsh 档依赖 DSH 会话里可用的模型，设置页在高级折叠里。 */
export const ASK_BACKEND_PRESETS = {
  http: { label: '自定义 API 端点（本地 / 云端通用，推荐）' },
  dsh: { label: 'DSH 当前会话模型（可选，取决于 DSH 配置）' },
};

/** 作答端识图能力三档。 */
export const VISION_MODE_PRESETS = {
  auto: { label: '自动探测（发一张随机数字图，看它答不答得出）' },
  yes: { label: '能看图（一步式，截图直接交给它）' },
  no: { label: '不能看图（有识图端就两步式，否则盲答）' },
};

/**
 * 气泡外观档位（设置页下拉框的数据源，两种浮层形态共用同一套 key）。
 * 只改 CSS，不改结构：换样式不会影响"你说：…"回显与错误提示。
 */
export const BUBBLE_STYLE_PRESETS = {
  classic: { label: '经典暗色（默认，圆角半透明）' },
  comic: { label: '漫画对白（白底黑边 + 硬阴影）' },
  glass: { label: '毛玻璃（微软风，浅色浮起）' },
  hud: { label: '游戏 HUD（深底青字，等宽）' },
  plain: { label: '纯文字（无底色，只留描边阴影）' },
};

/**
 * 截哪块屏（设置页下拉框数据源）。
 * 两块屏拼接后宽 4480，缩到 1600 每块只剩 800 多像素，细节全丢 —— 所以默认不拼。
 */
export const CAPTURE_TARGET_PRESETS = {
  auto: { label: '自动：游戏/前台窗口优先，没有就截主屏（默认）' },
  primary: { label: '主屏：整块主显示器' },
  secondary: { label: '副屏：另一块显示器' },
  window: { label: '只看当前窗口（不截整屏）' },
  all: { label: '双屏拼接（最全，但每块屏会被压得看不清）' },
};

/** 把 row config 归一化：类型不对就回落默认值，不抛错。 */
export function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const config = { ...DEFAULTS };

  config.enabled = boolean(source.enabled, DEFAULTS.enabled);
  config.requireFullscreen = boolean(source.requireFullscreen, DEFAULTS.requireFullscreen);
  config.ignoreMinimized = boolean(source.ignoreMinimized, DEFAULTS.ignoreMinimized);
  config.captureFullScreen = boolean(source.captureFullScreen, DEFAULTS.captureFullScreen);
  // captureTarget 是新的正规字段；没写过就按老的 captureFullScreen 推，老配置不会突然变行为。
  const rawTarget = typeof source.captureTarget === 'string' ? source.captureTarget.trim().toLowerCase() : '';
  config.captureTarget = Object.prototype.hasOwnProperty.call(CAPTURE_TARGET_PRESETS, rawTarget)
    ? rawTarget
    : source.captureFullScreen === true
      ? 'all'
      : DEFAULTS.captureTarget;

  config.games = Array.isArray(source.games)
    ? source.games.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
    : DEFAULTS.games;

  config.checkIntervalMs = clampNumber(source.checkIntervalMs, DEFAULTS.checkIntervalMs, 1000, 120000);
  config.intervalSec = clampNumber(source.intervalSec, DEFAULTS.intervalSec, 5, 3600);
  config.minGapMs = clampNumber(source.minGapMs, DEFAULTS.minGapMs, 0, 600000);
  config.snapshotTtlMs = clampNumber(source.snapshotTtlMs, DEFAULTS.snapshotTtlMs, 0, 3600000);
  config.timeoutMs = clampNumber(source.timeoutMs, DEFAULTS.timeoutMs, 5000, 180000);
  config.historyLimit = clampNumber(source.historyLimit, DEFAULTS.historyLimit, 0, 50);
  config.warmupMs = clampNumber(source.warmupMs, DEFAULTS.warmupMs, 0, 600000);

  config.provider = typeof source.provider === 'string' ? source.provider.trim() : DEFAULTS.provider;
  config.model = typeof source.model === 'string' ? source.model.trim() : DEFAULTS.model;
  config.visionProvider = typeof source.visionProvider === 'string' ? source.visionProvider.trim() : DEFAULTS.visionProvider;
  config.visionModel = typeof source.visionModel === 'string' ? source.visionModel.trim() : DEFAULTS.visionModel;
  config.visionApi = normalizeVisionApi(source.visionApi, DEFAULTS.visionApi);
  config.overlay = source.overlay === 'browser' ? 'browser' : source.overlay === 'window' ? 'window' : DEFAULTS.overlay;
  config.windowX = optionalNumber(source.windowX, DEFAULTS.windowX);
  config.windowY = optionalNumber(source.windowY, DEFAULTS.windowY);
  config.persona = typeof source.persona === 'string' && source.persona.trim() !== '' ? source.persona.trim() : DEFAULTS.persona;

  // 按键问答
  config.askEnabled = boolean(source.askEnabled, DEFAULTS.askEnabled);
  config.askModel =
    typeof source.askModel === 'string' && source.askModel.trim() !== '' ? source.askModel.trim() : DEFAULTS.askModel;
  config.askMaxTokens = clampNumber(source.askMaxTokens, DEFAULTS.askMaxTokens, 64, 8192);
  config.memoryLimit = clampNumber(source.memoryLimit, DEFAULTS.memoryLimit, 0, 50);
  config.memoryChars = clampNumber(source.memoryChars, DEFAULTS.memoryChars, 0, 8000);
  config.askPersona =
    typeof source.askPersona === 'string' && source.askPersona.trim() !== '' ? source.askPersona.trim() : DEFAULTS.askPersona;
  config.askOneShot = boolean(source.askOneShot, DEFAULTS.askOneShot);

  // 模型接入槽位
  const backend = typeof source.askBackend === 'string' ? source.askBackend.trim() : '';
  config.askBackend = Object.prototype.hasOwnProperty.call(ASK_BACKEND_PRESETS, backend) ? backend : DEFAULTS.askBackend;
  config.askApi = normalizeAskApi(source.askApi, DEFAULTS.askApi);
  config.visionProbe = normalizeVisionProbe(source.visionProbe, DEFAULTS.visionProbe);

  // 气泡回显识别文本 / 记忆模式 / 小窗尺寸
  config.echoQuestion = boolean(source.echoQuestion, DEFAULTS.echoQuestion);
  config.memoryMode =
    source.memoryMode === 'off' || source.memoryMode === 'always' || source.memoryMode === 'auto'
      ? source.memoryMode
      : DEFAULTS.memoryMode;
  config.windowWidth = clampNumber(source.windowWidth, DEFAULTS.windowWidth, 160, 1200);
  config.windowHeight = clampNumber(source.windowHeight, DEFAULTS.windowHeight, 160, 1200);
  // 气泡外观：只认白名单里的样式名，写错了回落 classic（不然会变成"没底色"的透明气泡）
  const style = typeof source.bubbleStyle === 'string' ? source.bubbleStyle.trim() : '';
  config.bubbleStyle = Object.prototype.hasOwnProperty.call(BUBBLE_STYLE_PRESETS, style) ? style : DEFAULTS.bubbleStyle;
  config.bubbleFontSize = clampNumber(source.bubbleFontSize, DEFAULTS.bubbleFontSize, 11, 20);
  config.bubbleMaxWidth = clampNumber(source.bubbleMaxWidth, DEFAULTS.bubbleMaxWidth, 160, 640);

  // 热键：设置页发扁平 {askScreen:'ctrl+alt+q'}，老配置是 extra 嵌套，两种都吃
  config.hotkeys = normalizeHotkeys(source.hotkeys, DEFAULTS.hotkeys);

  // 语音播报
  config.tts = normalizeTts(source.tts, DEFAULTS.tts);

  return config;
}

/** 热键归一化：扁平写法（设置页）与 extra 嵌套写法（配置样例）都认。 */
function normalizeHotkeys(raw, fallback) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const extra = source.extra && typeof source.extra === 'object' ? source.extra : {};
  const result = {
    ptt: typeof source.ptt === 'string' && source.ptt.trim() ? source.ptt.trim() : fallback.ptt,
    extra: {},
  };
  for (const key of Object.keys(fallback.extra)) {
    const flat = source[key];
    const nested = extra[key];
    if (typeof flat === 'string' && flat.trim()) {
      result.extra[key] = { enabled: true, key: flat.trim() };
    } else if (nested && typeof nested === 'object') {
      result.extra[key] = {
        enabled: boolean(nested.enabled, fallback.extra[key].enabled),
        key: typeof nested.key === 'string' && nested.key.trim() ? nested.key.trim() : fallback.extra[key].key,
      };
    } else {
      result.extra[key] = { ...fallback.extra[key] };
    }
  }
  return result;
}

/** tts 段归一化：字段错了就回落默认，绝不让一个拼错的值把播报搞哑。 */
function normalizeTts(raw, fallback) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const backend = typeof source.backend === 'string' ? source.backend.trim() : '';
  return {
    enabled: boolean(source.enabled, fallback.enabled),
    backend: Object.prototype.hasOwnProperty.call(TTS_BACKEND_PRESETS, backend) ? backend : fallback.backend,
    voice: typeof source.voice === 'string' ? source.voice.trim() : fallback.voice,
    speed: clampNumber(source.speed, fallback.speed, -10, 10),
    volume: clampNumber(source.volume, fallback.volume, 0, 100),
    streaming: boolean(source.streaming, fallback.streaming),
    maxChars: clampNumber(source.maxChars, fallback.maxChars, 10, 200),
  };
}

/**
 * 白名单匹配：进程名（去掉 .exe、大小写不敏感）或窗口标题包含关键字即命中。
 * 空白名单 = 全部命中（由调用方决定要不要这么用）。
 */
export function matchesGame(pattern, detection) {
  if (!pattern) return true;
  const needle = pattern.toLowerCase().replace(/\.exe$/, '');
  const process = String(detection.process ?? '')
    .toLowerCase()
    .replace(/\.exe$/, '');
  const title = String(detection.title ?? '').toLowerCase();
  const cls = String(detection.class ?? '').toLowerCase();
  return process === needle || process.includes(needle) || title.includes(needle) || cls.includes(needle);
}

function boolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/** apiKey 的哨兵值：设置页不改 Key 时回传它，表示"沿用已存的"。 */
export const KEEP_API_KEY = '__KEEP__';

/** 作答槽归一化：沿用 visionApi 的规则，但多一个识图能力档位。 */
function normalizeAskApi(raw, fallback) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const apiKey = typeof source.apiKey === 'string' && source.apiKey !== KEEP_API_KEY ? source.apiKey.trim() : '';
  const vision = typeof source.vision === 'string' ? source.vision.trim() : '';
  return {
    enabled: boolean(source.enabled, fallback.enabled),
    baseURL: typeof source.baseURL === 'string' ? source.baseURL.trim().replace(/\/+$/, '') : fallback.baseURL,
    model: typeof source.model === 'string' ? source.model.trim() : fallback.model,
    apiKey,
    format: source.format === 'anthropic' ? 'anthropic' : 'openai',
    maxTokens: clampNumber(source.maxTokens, fallback.maxTokens, 64, 32768),
    vision: Object.prototype.hasOwnProperty.call(VISION_MODE_PRESETS, vision) ? vision : fallback.vision,
  };
}

/** 探针结果：坏值归 unknown，绝不因为一条脏数据把用户判成"能看图"。 */
function normalizeVisionProbe(raw, fallback) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const status = typeof source.status === 'string' ? source.status.trim() : '';
  return {
    status: status === 'yes' || status === 'no' ? status : fallback.status,
    checkedAt: clampNumber(source.checkedAt, fallback.checkedAt, 0, Number.MAX_SAFE_INTEGER),
  };
}

function normalizeVisionApi(raw, fallback) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const apiKey = typeof source.apiKey === 'string' && source.apiKey !== KEEP_API_KEY ? source.apiKey.trim() : '';
  return {
    enabled: boolean(source.enabled, fallback.enabled),
    baseURL: typeof source.baseURL === 'string' ? source.baseURL.trim().replace(/\/+$/, '') : fallback.baseURL,
    model: typeof source.model === 'string' ? source.model.trim() : fallback.model,
    apiKey,
    format: source.format === 'anthropic' ? 'anthropic' : 'openai',
    maxTokens: clampNumber(source.maxTokens, fallback.maxTokens, 64, 32768),
  };
}

/** 可缺省的数字（窗口位置这类）：非数字一律当"没设置"。 */
function optionalNumber(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
}

function clampNumber(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}
