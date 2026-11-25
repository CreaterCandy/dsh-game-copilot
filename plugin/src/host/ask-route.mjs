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
