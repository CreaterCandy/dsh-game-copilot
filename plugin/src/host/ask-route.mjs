// ask-route.mjs —— 按"作答端能不能看图"选路线。
//
// 单独成文件有两个原因：
//   1. 它是纯函数，不依赖 DSH 的 llm 包，裸 Node 就能测（advise.mjs 顶层会 loadDsh）；
//   2. 将来做独立壳（§14）时，这个文件一行都不用改。
//
// 三个出口：
//   oneshot —— 作答端自己能看图，图 + 问题一次喂（最省一次往返）
//   twostep —— 作答端不能看，但识图槽能：先描述画面，再纯文本作答
//   blind   —— 都没有：不截图，并明确告诉用户"我看不到画面"

import { customVisionReady } from './vision-api.mjs';

/**
 * 盲答硬约束。拼在 system **最前面**，人设改语气也盖不过它。
 * 实测：没有图却不说"看不见"时，模型会用游戏常识脑补出
 * "先领阶段奖励…传送带"这种具体建议——比不答更糟。
 */
export const BLIND_CONSTRAINT = [
  '若本次没有附带任何画面，而问题必须看画面才能回答',
  '（含"这里/这个/画面/那个怪/这样摆对不对"），就只回一句：',
  '「我这边看不到画面，只能答不靠画面的问题。」',
  '禁止用游戏常识去推测画面内容，禁止把推测说成"我看到"。',
  '若问题本身不依赖画面（算数、规则、数值、做法），照常作答，不必提看不见。',
].join('\n');

/**
 * 手动覆盖优先于探针结果：askApi.vision = yes/no 时不看 probe。
 * askBackend !== 'http' 时返回 'dsh'，由 advise.mjs 走 DSH 会话模型链路。
 */
export function resolveAskRoute(config) {
  if (config.askBackend !== 'http') return { route: 'dsh' };

  const api = config.askApi;
  const answerReady = Boolean(api?.enabled && api?.baseURL && api?.model);
  const canSee = api?.vision === 'yes' || (api?.vision === 'auto' && config.visionProbe?.status === 'yes');

  if (answerReady && canSee) return { route: 'oneshot', api, via: `custom:${api.model}` };
  if (answerReady && customVisionReady(config.visionApi)) {
    return { route: 'twostep', api, visionApi: config.visionApi, via: `custom:${api.model}+${config.visionApi.model}` };
  }
  if (answerReady) return { route: 'blind', api, via: `custom:${api.model}` };

  // 没填作答端但填了识图端：老行为照旧（识图端直接作答），至少不哑火。
  if (customVisionReady(config.visionApi)) {
    return { route: 'oneshot', api: config.visionApi, via: `custom:${config.visionApi.model}` };
  }
  return { route: 'blind', api: null, via: 'none' };
}

/**
 * 这个模型到底认不认图 —— 元数据字段五花八门，必须把所有常见写法都认一遍。
 *
 * 2026-11-25 work 侧实测：注册表里模型明明声明了 `supportsImages: true`，
 * 旧代码只读 `inputModalities/modalities`，于是判定"没有支持图片的模型"，
 * 明明能看图却降级成盲答。
 *
 * 返回值三态：true 认图 / false 明确不认 / null 元数据没说（调用方自己决定）。
 */
export function modelAcceptsImage(model) {
  if (!model || typeof model !== 'object') return null;

  // 1) 显式布尔字段（不是所有注册表都按 OpenAI 那套 modalities 写）
  for (const flag of [model.supportsImages, model.supportsImage, model.supportsVision, model.vision]) {
    if (typeof flag === 'boolean') return flag;
  }

  // 2) 能力对象：{ capabilities: { vision: true } } / { capabilities: ['vision'] }
  const cap = model.capabilities ?? model.capability ?? null;
  if (Array.isArray(cap)) {
    if (cap.some((item) => /image|vision/i.test(String(item)))) return true;
  } else if (cap && typeof cap === 'object') {
    for (const key of ['image', 'images', 'vision', 'visual']) {
      if (typeof cap[key] === 'boolean') return cap[key];
    }
  }

  // 3) 模态列表：['text','image'] 或 { text:true, image:true }
  const modalities = model.inputModalities ?? model.modalities ?? model.input ?? null;
  if (Array.isArray(modalities)) {
    return modalities.some((item) => /image|vision/i.test(String(item)));
  }
  if (modalities && typeof modalities === 'object') {
    if (typeof modalities.image === 'boolean') return modalities.image;
    return null;
  }
  return null;
}

/** 盲答时模型的"标准认怂台词"，输出后校验要用同一句，避免两处文案漂移。 */
export const BLIND_REFUSAL = '我这边看不到画面，只能答不靠画面的问题。';

/** 拼在 prompt **末尾**的追加提醒：模型对最后一句最敏感（system 最前那条容易被长 prompt 冲淡）。 */
export const BLIND_TAIL_NOTE = `（提醒：本条没有附带任何画面。若必须看到画面才能回答，就只回「${BLIND_REFUSAL}」，不要拿游戏常识猜画面内容。）`;

/**
 * 盲答输出兜底：明明没图，模型却开始描述画面 —— 直接判为脑补。
 *
 * 为什么不只靠提示词：prompt 能压住绝大多数情况，但只要漏一次，用户就会
 * 收到"你左边那条传送带堵了"这种凭空捏造的具体建议，比不答更糟。
 * 所以这里做一层输出后校验，命中就换回标准台词，并在日志里留证据。
 *
 * 判定要窄：已经明说"看不到"的一律放过（里面本来就带"画面"二字）。
 */
export function blindAnswerIsFabricated(answer) {
  const text = String(answer ?? '').trim();
  if (!text) return false;
  // 已经老实说了看不见 = 合规，别再动它
  if (/看不到|看不见|没有画面|没画面|无法查看|看不到画面|没办法看/.test(text)) return false;
  // 断言自己在描述画面内容
  // 只抓"断言自己看到了具体画面/具体方位"的说法，不抓"这个传送带要接三通"这类
  // 不依赖画面的通用规则——那样会把合理回答也毙掉。
  return /我(?:看到|看见了)|画面(?:里|中|上)|图(?:里|中)|截图(?:里|中)|屏幕(?:上|中)|你(?:左边|右边|前面|后面|上方|下方|旁边|附近|现在|当前)/.test(
    text,
  );
}
