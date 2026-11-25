// advise.mjs —— 一次"看图 + 说话"。
//
// 为什么是**两步**（踩过的坑，别改回一步）：
//   本机默认会话模型是 `deepseek-vision`，那是 dsh-vision-router 注册的**自动识图包装**。
//   包装并不真把图片喂给文本模型，而是让模型**发起识图工具调用**（vision_describe），由宿主去执行。
//   插件如果直接把 ImageBlock 塞进这个包装的请求里，模型就把工具调用标记
//   （`<｜｜DSML｜｜ invoke ...>` 那一坨）当正文吐出来——气泡里就出现了"代码"。
//   所以这里拆开：
//     第 1 步：用**具备识图能力的** provider/model 把截图转成一段文字描述；
//     第 2 步：拿这段文字 + 最近几句，交给会话模型（纯文本）出一句台词。
//   两步都走 ctx.llm.stream；识图模型可在 config 里用 visionProvider/visionModel 指定。
//
// 无论哪一步，输出都过一层消毒：工具调用标记、残留标签、JSON 外壳一律剥掉；
// 实在没法用就结构化失败（宁可报错，也不把垃圾文本显示给用户）。
import { loadDsh } from './harness-loader.mjs';
import {
  askWithCustomApi,
  chatWithCustomApi,
  customVisionReady,
  describeWithCustomApi,
  redactVisionApi,
} from './vision-api.mjs';
import { ASK_MODEL_PRESETS } from './config.mjs';
import { chat, describe } from './http-llm.mjs';

// 路由判定拆到独立文件，裸 Node 也能单测；这里 re-export 给外部调用方。
export { resolveAskRoute, BLIND_CONSTRAINT } from './ask-route.mjs';
import { resolveAskRoute } from './ask-route.mjs';

const llm = await loadDsh('@deepseek-ai/dsh-llm');
const { BlockAssembler, ReasoningEffortId, createUserMessage } = llm;

/** 调用身份：DSH 用它给这次请求归属（缺了有些服务商会 400）。 */
const CALL_IDENTITY = 'dsh-game-copilot';

/**
 * 识图提示词：**只抽"是哪款游戏 + 当下关键局势"**，明确禁止逐项翻译画面。
 * 用户要的是"认出游戏 → 按这款游戏的玩法给建议"，不是听人念屏幕。
 */
const VISION_PROMPT = [
  '这是一张电脑屏幕截图，主人在玩游戏。只看**跟打游戏有关的信息**，别做画面翻译。',
  '',
  '第一行只写游戏名（能认出来就写官方名；认不出就写"未知（特征：…）"）。',
  '第二行开始写当下局势，最多 3 条，每条一行、每条不超过 25 字，只写这四类：',
  '  - 玩家状态：血量/蓝量/护盾/弹药/经济/等级这类**带数字**的',
  '  - 对面状态：正在打的敌人或对手、数量、是否在蓄力/读条/开大',
  '  - 眼前目标：任务提示、目标点、倒计时、还差什么',
  '  - 可用手段：技能/道具/商店/背包里眼下能用的东西',
  '',
  '禁止：不要描述美术风格、场景长得像什么、界面布局、也不要复述你看到的每一条文字；',
  '不要给建议、不要评价、不要感叹、不要寒暄；不要 JSON、不要 markdown、不要标题符号。',
].join('\n');

/**
 * 出话的人设：**活泼可爱的鲸鱼娘**（参考 DeepSeek 的小鲸鱼气质）。
 * 关键约束：不许复述画面（第一步已经抽成局势了），要**结合这款游戏的玩法**说话。
 */
const DEFAULT_PERSONA = [
  '你是主人电脑上的小鲸鱼娘：DeepSeek 家那只圆滚滚的小鲸鱼，黏人、话多、热心肠。',
  '说话要活泼可爱：短句、语气词、偶尔一个小颜文字，但别刷屏、别卖萌过头（别每句都"嘤嘤嘤"）。',
  '称呼自己"本鲸"或者"我"，称呼主人"你"。',
  '',
  '主人正在打一款具体的游戏，你也在旁边一起看。你要说的那句话是**给这款游戏的建议或吐槽**：',
  '说明白"现在该干什么"，而且要**贴这款游戏的玩法**（它有什么机制、这个局面该注意什么）。',
  '判断标准很硬：把这句话原封不动搬到另一款游戏里，如果依然成立，就是不合格的，重写。',
  '  ✅「它蓄力了，本鲸数三下你就翻滚」',
  '  ✅「先把小怪清掉，不然一会儿被包夹」',
  '  ✅「血这么少还往前冲？先嗑药啦！」',
  '  ✅「钱够了，回城把那把剑买了」',
  '  ❌「注意安全」「小心点」「加油」「稳住」「保持专注」——放到哪都成立的空话',
  '  ❌「画面里有血条和敌人」——这是念屏幕，不是建议',
  '',
  '规矩：',
  '1) 只给一条最要紧的，别列清单、别分点、别说教。',
  '2) 口语化，像真人凑在旁边随口说一句；34 个字以内（含颜文字）。',
  '3) 局势信息不够（主菜单/加载中/看视频）时，就活泼地吐槽一句当下场景，同样**不要念屏幕**；',
  '   **绝不要**说"我没有看到图片""请重新上传"这类话。',
  '4) 只输出这句话本身：不要解释、不要任何标记、不要 JSON、不要前后缀。',
].join('\n');

/**
 * 按键问答的人设：游戏助理（和 runtime/ask.py 的 SYSTEM_PROMPT 保持一致）。
 * 与自动建议的"鲸鱼娘 34 字"不同——玩家主动问的要答完整句、算数只给结论、不念符号。
 */
const ASK_PERSONA = [
  '你是玩家电脑上的游戏助理，坐在玩家旁边看画面、认游戏、答问题、给下一步该做什么。',
  '先用截图认出玩家正在玩哪款游戏，再按那款游戏的玩法作答；没认出来就按画面里的实际局势答，别硬套别的游戏。',
  '',
  '回答要求：',
  '1) 用中文口语，说成完整的句子，不要只丢一个数字或一个词。',
  '2) 算数题：按画面里的数字算准，只回答一句结论句，不要复述条件、不要写推导过程。',
  '   例：问「这堆矿能造几个炉子」，答「这些矿可以造 8 个炉子」。',
  '3) 其他问题：给一条最有用的可执行建议，一到两句话说完；要贴当前这款游戏，别给放到哪都成立的空话。',
  '4) 不要描述界面、不要复述 UI、看不清的数字不要编。',
  '',
  '格式硬要求（回答会被念出来）：',
  '绝对不要用 Markdown——不要星号、井号、反引号、方括号、表格、编号列表。',
  '只用普通中文和标点。',
].join('\n');

/**
 * 一次完整的"看图 + 说话"。
 * @param {{ ctx: any, config: any, image: Buffer|null, detection: any, notes: string[],
 *   elapsedMs: number, selection: { provider: string, model: string } }} input
 * @returns {Promise<{ ok: true, screen: string, say: string } | { ok: false, reason: string, message?: string, screen?: string }>}
 */
export async function adviseOnce({ ctx, config, image, detection, notes, elapsedMs, selection }) {
  const llmService = ctx.llm;
  if (!llmService || typeof llmService.stream !== 'function') {
    return { ok: false, reason: 'llm-unavailable', message: 'LLM 服务不可用' };
  }
  const target = selection?.provider && selection?.model ? selection : null;
  if (!target) {
    return { ok: false, reason: 'model-missing', message: '没有可用的模型（当前对话没选模型，插件也没配）' };
  }

  // ── 第 1 步：识图（有图才做）────────────────────────────────────────────
  let screen = '';
  if (image && image.length > 0) {
    const vision = await describeImage({ ctx, llmService, config, image, detection });
    if (vision.ok) screen = vision.text;
    else {
      return { ok: false, reason: 'vision-failed', message: vision.message ?? '截图没能转成文字描述' };
    }
  }

  // ── 第 2 步：出话（纯文本）────────────────────────────────────────────
  const prompt = buildPrompt({ detection, notes, elapsedMs, screen });
  const text = await callText({
    ctx,
    llmService,
    config,
    selection: target,
    system: config.persona || DEFAULT_PERSONA,
    prompt,
  });
  if (!text.ok) return { ok: false, reason: text.reason, message: text.message };

  const say = sanitizeSay(text.text);
  if (!say) {
    return {
      ok: false,
      reason: 'empty-response',
      message: '模型这次只回了标记或空内容，没有可用的话',
      screen,
    };
  }
  return { ok: true, screen, say };
}

/**
 * 按键问答：把「玩家的问题 + 截图 + 相关历史」交给模型，给一句完整回答。
 *
 * 与 adviseOnce 的区别：
 *   - 人设是"助理"（完整句 / 算数给结论），不是鲸鱼娘的 34 字台词；
 *   - prompt 带真实问题和历史问答（记忆），能接上"那要几台"这种追问；
 *   - 优先一步式（图 + 问题一次喂），失败才退两步——省掉一次模型往返。
 *
 * @param {{ ctx:any, config:any, image?:Buffer|null, imageType?:string, question:string,
 *   history?: Array<{q:string,a:string}>, detection?:any,
 *   selection?:{provider:string,model:string}|null }} input
 * @returns {Promise<{ok:true, answer:string, screen:string, mode:string}
 *   | {ok:false, reason:string, message?:string, screen?:string}>}
 */
export async function askQuestion({ ctx, config, image, imageType, question, history, detection, selection, preferLocal = true }) {
  const llmService = ctx.llm;
  const asked = String(question ?? '').trim();
  if (!asked) return { ok: false, reason: 'empty-question', message: '问题为空' };

  const system = (typeof config.askPersona === 'string' && config.askPersona.trim()) || ASK_PERSONA;
  const maxTokens = config.askMaxTokens ?? 512;

  // ── 本项目主路径：按"作答端能不能看图"分派 ────────────────────────────
  // 只接管 askBackend=http。dsh 档保持下面原有逻辑不变。
  const route = resolveAskRoute(config);
  if (route.route !== 'dsh') {
    if (!route.api) {
      return {
        ok: false,
        reason: 'no-api',
        message: '还没填模型端点。去设置页「模型与能力」填一个 OpenAI 兼容端点即可（本地或云端）。',
      };
    }
    const common = { timeoutMs: config.timeoutMs, maxTokens };
    const prompt = buildAskPrompt({ question: asked, history, detection });

    // 盲答：不传图，且把硬约束拼在人设之前
    if (route.route === 'blind') {
      const reply = await chat({
        api: route.api,
        system: `${BLIND_CONSTRAINT}\n\n${system}`,
        prompt,
        ...common,
      });
      if (!reply.ok) return { ok: false, reason: 'blind-failed', message: reply.message, screen: '' };
      const answer = sanitizeSay(reply.text);
      if (!answer) return { ok: false, reason: 'bad-output', message: '盲答输出不可用', screen: '' };
      return { ok: true, answer, screen: '', mode: 'blind', via: route.via, noticeBlind: true };
    }

    // 一步式：作答端自己能看图
    if (route.route === 'oneshot') {
      const reply = await chat({ api: route.api, system, prompt, image, imageType, ...common });
      if (!reply.ok) return { ok: false, reason: 'oneshot-failed', message: reply.message, screen: '' };
      const answer = sanitizeSay(reply.text);
      if (!answer) return { ok: false, reason: 'bad-output', message: '一步式输出不可用', screen: '' };
      return { ok: true, answer, screen: '', mode: 'oneshot', via: route.via };
    }

    // 两步式：识图端描述画面 → 作答端纯文本回答
    if (route.route === 'twostep') {
      const described = await describe({
        api: route.visionApi,
        image,
        prompt: '用中文客观描述这张游戏画面里最关键的信息（在做什么、有什么危险、下一步该干什么）。不要编造看不清的细节。',
        timeoutMs: config.timeoutMs,
      });
      if (!described.ok) return { ok: false, reason: 'describe-failed', message: described.message, screen: '' };
      const reply = await chat({
        api: route.api,
        system,
        prompt: `【画面描述】\n${described.text}\n\n${prompt}`,
        ...common,
      });
      if (!reply.ok) return { ok: false, reason: 'twostep-failed', message: reply.message, screen: described.text };
      const answer = sanitizeSay(reply.text);
      if (!answer) return { ok: false, reason: 'bad-output', message: '两步式输出不可用', screen: described.text };
      return { ok: true, answer, screen: described.text, mode: 'twostep', via: route.via };
    }
  }

  const target = selection?.provider && selection?.model ? selection : null;
  const errors = [];

  // ── 路线 A：一步式（图 + 问题 + 人设 一次喂）────────────────────────────
  // 只走"自己填的视觉 API"：这条路把 base64 直接塞进请求体，
  // 不依赖 DSH 的附件服务——附件服务在本机实测拿不到，走它必然白等一次。
  //
  // ⚠️ preferLocal 的含义：只有"没指定云端模型"（跟随 / 本地档）才走这里。
  //    一旦用户在设置页明确选了云端模型，就**不能**用本地模型抢答——
  //    否则选了云端还是本地在答，等于开关没生效。
  if (preferLocal && customVisionReady(config.visionApi)) {
    const prompt = buildAskPrompt({ question: asked, history, detection });
    const one = await askWithCustomApi({
      api: config.visionApi,
      system,
      image,
      imageType,
      prompt,
      timeoutMs: config.timeoutMs,
      maxTokens,
    });
    if (one.ok) {
      const answer = sanitizeSay(one.text);
      if (answer) return { ok: true, answer, screen: '', mode: 'oneshot', via: `custom:${config.visionApi.model}` };
      errors.push('一步式输出不可用（像工具调用标记）');
    } else {
      errors.push(`一步式失败：${one.message}`);
    }
  }

  // ── 路线 A2：一步式·云端（截图直接交给回答模型）──────────────────────────
  // 少一次单独的识图往返，但有两个硬前提，缺一不可：
  //   ① DSH 附件服务可用 —— 图片块只能引用附件，不接受裸 base64（视觉路由也是这么吃图的）；
  //   ② 该模型在 DSH 注册表里声明了图片输入。
  // 所以默认关（config.askOneShot）；开了也只在失败时退回两步式，不会把问答弄哑。
  if (!preferLocal && config.askOneShot) {
    const one = await askCloudOneShot();
    if (one.ok) return one;
    errors.push(`一步式云端失败：${one.message ?? one.reason}`);
  }

  // ── 路线 B：两步式（先识图出局势，再让选定模型作答）──────────────────────
  // 只有"明确选了云端模型"才走这条：本地档走它等于两次本地调用，反而更慢。
  if (!preferLocal) {
    const two = await runTwoStep();
    if (two.ok) return two;
    errors.push(`两步式失败：${two.message ?? two.reason}`);
  }

  // ── 路线 C：本地一步式兜底 ─────────────────────────────────────────────
  // 云端不通（没网 / provider 路由失败 / 欠费）时不能让按键哑火：
  // 退回自定义视觉端点也要给出一句话，并在 mode 里标明是兜底结果。
  if (!preferLocal && customVisionReady(config.visionApi)) {
    const prompt = buildAskPrompt({ question: asked, history, detection });
    const one = await askWithCustomApi({
      api: config.visionApi,
      system,
      image,
      imageType,
      prompt,
      timeoutMs: config.timeoutMs,
      maxTokens,
    });
    if (one.ok) {
      const answer = sanitizeSay(one.text);
      if (answer) return { ok: true, answer, screen: '', mode: 'local-fallback', via: `custom:${config.visionApi.model}` };
      errors.push('本地兜底输出不可用');
    } else {
      errors.push(`本地兜底失败：${one.message}`);
    }
  }

  return {
    ok: false,
    reason: 'ask-failed',
    message: errors.length > 0 ? errors.join(' | ') : '问答没有走通',
  };

  /** 一步式·云端：附件引用 + 图片块 + 问题，一次喂给选定模型。 */
  async function askCloudOneShot() {
    if (!llmService || typeof llmService.stream !== 'function') {
      return { ok: false, reason: 'llm-unavailable', message: 'LLM 服务不可用（DSH 的模型服务没就绪）' };
    }
    if (!target) return { ok: false, reason: 'model-missing', message: '没有可用的模型' };
    if (!image || image.length === 0) return { ok: false, reason: 'no-image', message: '这次没有截图' };

    const attachment = await attachImage(ctx, image, imageType);
    if (!attachment) {
      return {
        ok: false,
        reason: 'no-attachments',
        message: 'DSH 附件服务不可用（图片块只能引用附件，不能塞裸 base64）',
      };
    }

    const prompt = buildAskPrompt({ question: asked, history, detection });
    const text = await streamText({
      llmService,
      options: {
        provider: target.provider,
        model: target.model,
        sessionId: CALL_IDENTITY,
        messages: [
          createUserMessage({
            content: [
              { type: 'image', attachment },
              { type: 'text', text: prompt },
            ],
            source: { kind: 'plugin', plugin: 'dsh-game-copilot' },
          }),
        ],
        system,
        temperature: 1,
        ...(await reasoningOff(llmService, target)),
        signal: AbortSignal.timeout(config.timeoutMs),
      },
    });
    if (!text.ok) return { ok: false, reason: text.reason, message: text.message };
    const answer = sanitizeSay(text.text);
    if (!answer) return { ok: false, reason: 'empty-response', message: '模型没给出可用回答' };
    return { ok: true, answer, screen: '', mode: 'oneshot-cloud', via: `${target.provider}/${target.model}` };
  }

  /** 两步式：本地识图 → 选定模型出话。 */
  async function runTwoStep() {
    if (!llmService || typeof llmService.stream !== 'function') {
      return { ok: false, reason: 'llm-unavailable', message: 'LLM 服务不可用（DSH 的模型服务没就绪）' };
    }
    if (!target) {
      return { ok: false, reason: 'model-missing', message: '没有可用的模型（当前对话没选模型，插件也没配）' };
    }

    let screen = '';
    if (image && image.length > 0) {
      const vision = await describeImage({ ctx, llmService, config, image, detection });
      if (vision.ok) screen = vision.text;
      else errors.push(`识图失败：${vision.message ?? '未知'}`);
    }

    const prompt = buildAskPrompt({ question: asked, history, detection, screen });
    // preferSelected：玩家明确选了云端档位，就让选中的模型先出话（本地 9B 只做兜底）
    const text = await callText({
      ctx,
      llmService,
      config,
      selection: target,
      system,
      prompt,
      preferSelected: true,
    });
    if (!text.ok) return { ok: false, reason: text.reason, message: text.message };

    const answer = sanitizeSay(text.text);
    if (!answer) return { ok: false, reason: 'empty-response', message: '模型没给出可用回答', screen };
    if (text.via?.startsWith('custom:')) {
      // 走到这儿说明选中的云端模型失败了，是本地 9B 救的场：标成 local-fallback，
      // 免得日志里看到"云端成功"却其实是本地答的。
      return { ok: true, answer, screen, mode: 'local-fallback', via: text.via };
    }
    return { ok: true, answer, screen, mode: 'twostep', via: text.via };
  }
}

/** 按键问答的 prompt：问题 + 历史 + 画面线索一起给。 */
function buildAskPrompt({ question, history, detection, screen }) {
  const lines = [];
  const where = detection?.title || detection?.process || '';
  if (where) lines.push(`（玩家现在开着：${where}）`);

  if (screen) {
    lines.push('');
    lines.push('你从截图里看到的情况（只当依据，不要念给玩家听）：');
    lines.push(screen.trim());
  }

  if (Array.isArray(history) && history.length > 0) {
    lines.push('');
    lines.push('之前聊过的（按时间先后；玩家说"那 / 这个 / 刚才"时靠这些理解）：');
    for (const item of history) {
      const q = String(item?.q ?? '').trim().slice(0, 200);
      const a = String(item?.a ?? '').trim().slice(0, 300);
      if (!q) continue;
      lines.push(`- 问：${q}`);
      if (a) lines.push(`  答：${a}`);
    }
  }

  lines.push('');
  lines.push(`玩家现在问：${question}`);
  lines.push('');
  lines.push('直接回答这个问题（一到两句，完整句子，不带任何格式符号）。');
  return lines.join('\n');
}

/** 第 1 步：把截图交给"能看图的模型"，要一段文字。 */
async function describeImage({ ctx, llmService, config, image, detection }) {
  const errors = [];
  const prompt = `${VISION_PROMPT}\n\n（正在玩的游戏：${detection?.title || detection?.process || '未知'}）`;

  // ① 用户自己填的视觉模型 API（填了就它优先——这是"注册表里没有可用识图模型"时的正解）。
  //    这条**不需要 DSH 附件服务**：直接把图 base64 进请求体，
  //    所以"附件不可用"不能当成前置条件挡在这里（踩过：真跑时被它误杀）。
  if (customVisionReady(config.visionApi)) {
    const custom = await describeWithCustomApi({
      api: config.visionApi,
      image,
      prompt,
      timeoutMs: config.timeoutMs,
    });
    if (custom.ok) {
      const text = sanitizeScreen(custom.text);
      if (text) return { ok: true, text, provider: '自定义 API', model: config.visionApi.model };
      errors.push('自定义 API: 输出不可用（看起来它没真读到图）');
    } else {
      errors.push(`自定义 API: ${custom.message}`);
    }
  }

  // ② 注册表里探测出来的候选（这条**需要**附件服务：DSH 的 image block 只认附件引用）
  const attachment = await attachImage(ctx, image);
  const candidates = await visionCandidates(llmService, config);
  if (candidates.length === 0 || !attachment) {
    // 注册表这条路可能本来就探测不到（本机实测就是空）——试免配置的免费匿名视觉模型
    if (candidates.length > 0 && !attachment) {
      errors.push('附件服务不可用：注册表候选走的是 DSH 附件引用，这条路用不了');
    }
    const free = await describeWithCustomApi({
      api: FREE_FALLBACK_API,
      image,
      prompt,
      timeoutMs: config.timeoutMs,
    });
    if (free.ok) {
      const text = sanitizeScreen(free.text);
      if (text) {
        return { ok: true, text, provider: '免费匿名视觉模型', model: FREE_FALLBACK_API.model };
      }
      errors.push('免费兜底: 输出不可用');
    } else {
      errors.push(`免费兜底: ${free.message}`);
    }
    return {
      ok: false,
      reason: 'vision-model-missing',
      message: `没找到可用的识图模型：注册表里没有支持图片的模型，免费的匿名视觉模型也没打通。可以在设置页「视觉模型 API」里填一个自己的识图服务。${errors.length ? `（${errors.join(' | ')}）` : ''}`,
    };
  }

  for (const candidate of candidates) {
    const content = [
      { type: 'image', attachment },
      { type: 'text', text: prompt },
    ];
    const result = await streamText({
      llmService,
      options: {
        provider: candidate.provider,
        model: candidate.model,
        sessionId: CALL_IDENTITY,
        messages: [
          createUserMessage({ content, source: { kind: 'plugin', plugin: 'dsh-game-copilot' } }),
        ],
        system: '你是识图助手：只负责从截图里认出这是哪款游戏、并抽出现下的关键局势，不做画面描述。',
        temperature: 1,
        signal: AbortSignal.timeout(config.timeoutMs),
      },
    });
    if (result.ok) {
      const text = sanitizeScreen(result.text);
      if (text) return { ok: true, text, provider: candidate.provider, model: candidate.model };
      errors.push(`${candidate.provider}/${candidate.model}: 输出不可用`);
    } else {
      errors.push(`${candidate.provider}/${candidate.model}: ${result.message}`);
    }
  }
  return { ok: false, reason: 'vision-failed', message: errors.join(' | ') };
}

/**
 * 第 2 步：纯文本出一句话。
 *
 * 两个来源：自己填的「视觉模型 API」和 DSH 会话模型。
 * 顺序由 `preferSelected` 决定：
 *   - false（自动吐槽）：自定义 API 先，失败再用会话模型——一个 Key 全包，最省事；
 *   - true（按键问答里明确选了云端模型）：**选中的模型先**，
 *     自定义 API 只当兜底。否则两步式的出话会先被本地模型接走、一次成功就返回，
 *     选中的云端模型根本没被调用——表现为"设置页选了云端，答的还是本地"（踩过）。
 *
 * 返回值里的 `via` 标明这句话到底是谁出的（custom:模型 或 provider/model），
 * 用来在日志/回包里核对"开关有没有真生效"。
 */
async function callText({ ctx, llmService, config, selection, system, prompt, preferSelected = false }) {
  const errors = [];
  const viaSelected = selection?.provider && selection?.model ? `${selection.provider}/${selection.model}` : '';

  const callCustom = async () => {
    if (!customVisionReady(config.visionApi)) return null;
    const custom = await chatWithCustomApi({
      api: config.visionApi,
      system,
      prompt,
      timeoutMs: config.timeoutMs,
      maxTokens: config.visionApi.maxTokens,
    });
    if (custom.ok) return { ok: true, text: custom.text, via: `custom:${config.visionApi.model}` };
    errors.push(`自定义 API 出话失败：${custom.message}`);
    return null;
  };

  const callModel = async () => {
    if (!viaSelected) return null;
    const options = {
      provider: selection.provider,
      model: selection.model,
      sessionId: CALL_IDENTITY,
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'plugin', plugin: 'dsh-game-copilot' },
        }),
      ],
      system,
      temperature: 1,
      ...(await reasoningOff(llmService, selection)),
      signal: AbortSignal.timeout(config.timeoutMs),
    };
    const result = await streamText({ llmService, options });
    if (result.ok) return { ok: true, text: result.text, via: viaSelected };
    errors.push(`${viaSelected || '会话模型'}：${result.message}`);
    return null;
  };

  const first = preferSelected ? callModel : callCustom;
  const second = preferSelected ? callCustom : callModel;
  const hit = (await first()) ?? (await second());
  if (hit) return hit;
  // 两边都失败：把两边的真实原因都带上，别只报一半
  return {
    ok: false,
    reason: 'generate-error',
    message: errors.length > 0 ? errors.join(' | ') : '没有可用的出话通道',
  };
}

/** 识图候选链：config 指定 → 直连视觉路由 → 注册表里声明支持图片的模型。 */
async function visionCandidates(llmService, config) {
  const list = [];
  const push = (provider, model) => {
    if (typeof provider !== 'string' || typeof model !== 'string' || !provider || !model) return;
    if (list.some((item) => item.provider === provider && item.model === model)) return;
    list.push({ provider, model });
  };

  push(config.visionProvider, config.visionModel);

  // dsh-vision-router 的直连视觉路由：它本身就是"把图交给视觉模型"，不经包装、不要工具。
  // ⚠️ 必须用 `llmService.listProviders()` 这种**方法调用**，不能把函数摘下来再调：
  //    它是挂在服务对象上的方法（内部用 this），摘下来 this 就丢了，探测会静默失败——
  //    踩过，表现为"没找到可用的识图模型"，而路由其实好好地在注册表里。
  const providers = await safeProviders(llmService);
  if (providers.includes('vision-http')) {
    for (const model of await safeModels(llmService, 'vision-http')) {
      push('vision-http', model?.id ?? model?.name);
    }
  }

  // 兜底：注册表里自己声明支持图片输入的模型
  for (const provider of providers) {
    if (provider === 'vision-http') continue;
    for (const model of await safeModels(llmService, provider)) {
      const modalities = model?.inputModalities ?? model?.modalities;
      if (Array.isArray(modalities) && modalities.some((m) => String(m).includes('image'))) {
        push(provider, model?.id ?? model?.name);
      }
    }
  }
  return list;
}

/**
 * 可选兜底：一个公开的免费匿名视觉端点（无需注册/Key）。
 * 公开版默认关闭：它不在本项目控制范围内，且有速率限制；
 * 开启前请确认你愿意把截图发往该第三方服务。
 */
const FREE_FALLBACK_API = {
  // 公开版默认关闭：匿名第三方端点会把截图发往外部服务，需在知情前提下自行开启。
  enabled: false,
  baseURL: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
  model: 'Qwen3.5-397B-A17B',
  apiKey: '',
  format: 'openai',
  maxTokens: 1024,
};

/** 列出注册的 provider（拿不到就是空数组，绝不抛）。 */
async function safeProviders(llmService) {
  try {
    if (typeof llmService?.listProviders !== 'function') return [];
    const value = llmService.listProviders();
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/** 列出一个 provider 的模型（拿不到就是空数组，绝不抛）。 */
async function safeModels(llmService, provider) {
  try {
    if (typeof llmService?.listModels !== 'function') return [];
    const value = await llmService.listModels(provider);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/** 诊断用：把"识图候选是怎么算出来的"完整暴露出来（设置页的识图卡片用它）。 */
export async function inspectVision({ ctx, config }) {
  const llmService = ctx.llm;
  if (!llmService) return { available: false, reason: 'llm-unavailable' };
  const providers = await safeProviders(llmService);
  const listing = [];
  for (const provider of providers) {
    const models = await safeModels(llmService, provider);
    listing.push({
      provider,
      models: models.slice(0, 12).map((model) => ({
        id: model?.id ?? model?.name ?? '?',
        modalities: model?.inputModalities ?? model?.modalities ?? null,
      })),
    });
  }
  const candidates = await visionCandidates(llmService, config);
  const custom = redactVisionApi(config.visionApi);
  const customUsable = customVisionReady(config.visionApi);

  // 一步式（把截图直接交给回答模型）到底可不可行，看这两条：附件服务在不在、这个模型认不认图。
  // 这里看的是**问答档位**用的那个模型（askModel），不是自动开口的 provider/model。
  const attach = typeof ctx.get === 'function' ? ctx.get('attachments', false) : undefined;
  const attachmentsReady = typeof attach?.saveImage === 'function';
  const askPreset = ASK_MODEL_PRESETS[config.askModel] ?? null;
  const askProvider = askPreset?.provider || config.provider || '';
  const askName = askPreset?.model || config.model || '';
  let askModel = null;
  if (askName) {
    let info = null;
    try {
      info = (await llmService.resolveModelInfo?.(askProvider, askName)) ?? null;
    } catch {
      info = null;
    }
    const inputs = info?.inputModalities ?? info?.input ?? info?.modalities ?? null;
    const acceptsImage = Array.isArray(inputs)
      ? inputs.some((item) => String(item).toLowerCase().includes('image'))
      : inputs && typeof inputs === 'object'
        ? Boolean(inputs.image)
        : null; // null = 元数据没声明，说不好
    askModel = { provider: askProvider || null, model: askName, acceptsImage };
  }

  // 注册表可能是空的（本机实测就是）——那就靠免配置的免费匿名视觉模型兜底，
  // 所以设置页的"可用"判定必须把它算进去，否则界面显示"不可用"而实际上能跑。
  const usable = customUsable || candidates.length > 0 || FREE_FALLBACK_API.model;
  return {
    available: usable,
    customApi: { ...custom, usable: customUsable },
    providers,
    listing,
    candidates,
    freeFallback: { url: FREE_FALLBACK_API.baseURL, model: FREE_FALLBACK_API.model, keyless: true },
    usingFreeFallback: !customUsable && candidates.length === 0,
    configured: { provider: config.visionProvider || null, model: config.visionModel || null },
    // 一步式能不能走：这两项都 true 才成立（设置页拿它给用户解释"为什么还要两步"）
    oneShot: {
      enabled: Boolean(config.askOneShot),
      attachmentsReady,
      askModel,
      possible: Boolean(config.askOneShot && attachmentsReady && askModel?.acceptsImage !== false),
    },
  };
}

/** 跑一次流式生成，返回拼好的正文。 */
async function streamText({ llmService, options }) {
  const assembler = new BlockAssembler();
  try {
    for await (const chunk of llmService.stream(options)) {
      assembler.push(chunk);
    }
  } catch (error) {
    return { ok: false, reason: 'generate-error', message: errorText(error) };
  }
  const text = collectText(assembler);
  if (!text) return { ok: false, reason: 'empty-response', message: emptyReason(assembler) };
  return { ok: true, text };
}

function buildPrompt({ detection, notes, elapsedMs, screen }) {
  const lines = [];
  lines.push(`窗口标题：${detection?.title || '(没有标题)'}（进程 ${detection?.process || '未知'}）`);
  lines.push(`已经玩了：${formatDuration(elapsedMs)}`);
  if (screen) {
    lines.push('');
    lines.push('你从截图里认出/看到的东西（第一行是游戏名，后面是当下局势）：');
    lines.push(screen.trim());
    lines.push('');
    lines.push('注意：这些只是线索，**别把它们念给主人听**。主人看得见自己的屏幕。');
    lines.push('你要做的是：判断这是哪款游戏、这个局面下该干什么，然后用你自己的话给一句建议。');
  } else {
    lines.push('这次没拿到截图，只能靠上面这些信息说话（别编游戏内容）。');
  }
  if (Array.isArray(notes) && notes.length > 0) {
    lines.push('');
    lines.push('你之前几句说过这些（接着往下聊，别重复同样的意思）：');
    for (const note of notes) lines.push(`- ${note}`);
  }
  lines.push('');
  lines.push('现在直接给出你要说的那一句话（34 字以内，不要引号、不要解释）。');
  lines.push('自检三遍：');
  lines.push('  ① 这句是"建议/提醒/吐槽"，还是只是在念屏幕？念屏幕就重写。');
  lines.push('  ② 换成别的游戏还成不成立？成立就重写（说明太笼统）。');
  lines.push('  ③ 有鲸鱼娘那股活泼劲儿吗？像说明书就重写。');
  return lines.join('\n');
}

/** 把图片存成 DSH 附件，拿到 image block 需要的 ref。
 *  mediaType 要跟真实字节一致（按键问答送进来的是 JPEG，写死 png 有的下游会拒）。 */
async function attachImage(ctx, image, mediaType = 'image/png') {
  const attachments = typeof ctx.get === 'function' ? ctx.get('attachments', false) : undefined;
  if (!attachments || typeof attachments.saveImage !== 'function') return null;
  const type = typeof mediaType === 'string' && mediaType.startsWith('image/') ? mediaType : 'image/png';
  const ext = type === 'image/jpeg' ? 'jpg' : type.split('/')[1] || 'png';
  try {
    return (await attachments.saveImage({ data: image, mediaType: type, name: `game.${ext}` })) ?? null;
  } catch {
    return null;
  }
}

/** 只在该模型声明支持 reasoning effort 时才传 off，否则会被判 UNSUPPORTED 折叠成空流。 */
async function reasoningOff(llmService, selection) {
  try {
    if (typeof llmService.resolveModelInfo !== 'function') return {};
    const info = await llmService.resolveModelInfo(selection.provider, selection.model);
    const efforts = info?.reasoningEfforts;
    if (Array.isArray(efforts) && efforts.includes('off')) {
      return { reasoningEffort: ReasoningEffortId('off') };
    }
  } catch {
    // 拿不到元数据就不传
  }
  return {};
}

function collectText(assembler) {
  return assembler
    .blocks()
    .filter((block) => block && block.type === 'text')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('')
    .trim();
}

function emptyReason(assembler) {
  const finish = assembler?.finish;
  if (!finish) return '模型没有返回文本';
  if (finish.kind === 'aborted') return `生成被中断：${finish.failure?.message ?? 'unknown'}`;
  if (finish.kind === 'error') return `生成失败：${finish.failure?.message ?? 'unknown'}`;
  if (finish.kind === 'max-tokens') return '生成被 max-tokens 截断，没留下正文';
  return '模型没有返回文本';
}

/**
 * 消毒"台词"：先判断这段是不是工具调用/标记（是就整体丢弃），再剥残留标记与外壳。
 * 认不出来就返回空串（调用方报结构化失败，绝不把垃圾显示到气泡里）。
 */
export function sanitizeSay(raw) {
  const original = String(raw ?? '');
  // 关键顺序：**先判断、再剥**。反过来会把标记剥掉、只剩下参数正文（实测踩过：
  // 剥完剩 `["sha256:..."] 这张截图里是什么画面？`，看着像人话其实是垃圾）。
  if (looksLikeToolCall(original)) return '';
  // 模型偶尔会把话包在 {"say": "..."} 里：那是外壳，不是工具调用，先把正文取出来
  const unwrapped = extractSayFromJson(original) ?? original;
  if (looksLikeToolCall(unwrapped)) return '';
  const text = stripToolMarkup(unwrapped);
  if (looksLikeToolCall(text)) return '';
  const cleaned = cleanSpacing(text);
  // "我没看到图片/请重新上传"这类敷衍话别进气泡（识图那步已经会失败并给出真原因）
  if (looksLikeNoImage(cleaned)) return '';
  return cleaned;
}

/** 消毒"画面描述"：同样先判断后剥，只是保留正文。 */
export function sanitizeScreen(raw) {
  const original = String(raw ?? '');
  if (looksLikeToolCall(original)) return '';
  const unwrapped = extractSayFromJson(original) ?? original;
  if (looksLikeToolCall(unwrapped)) return '';
  const text = stripToolMarkup(unwrapped);
  if (looksLikeToolCall(text)) return '';
  const cleaned = cleanSpacing(text);
  // 有些模型会"假装看不到图"然后开始复述要求（实测 glm 系列就这样）：
  // 这种输出对识图这一步毫无价值，当失败处理，让候选链继续往下试。
  if (looksLikeNoImage(cleaned)) return '';
  return cleaned;
}

/** 这像不像"我没看到图片"的敷衍回复。 */
function looksLikeNoImage(text) {
  if (!text) return false;
  return /(没有(看到|收到|获取到|检测到)|未能(看到|识别)|无法(看到|查看|识别)|看不到).{0,12}(图片|图像|截图|附件)|请(重新)?上传|似乎没有.{0,8}(图片|附件)/.test(
    text,
  );
}

/** 剥掉模型漏出来的工具调用 / 特殊标记。 */
function stripToolMarkup(input) {
  let text = input;
  // 全角/半角竖线组成的 DSML 标记，以及常见工具调用标签
  text = text.replace(
    /<[｜|]{0,4}[^<>\n]{0,120}(DSML|invoke|parameter|tool_calls?|function_calls?)[^<>\n]{0,120}[｜|]{0,4}>/gi,
    ' ',
  );
  text = text.replace(/<\/[｜|]{0,4}[^<>\n]{0,120}>/gi, ' ');
  text = text.replace(/<\|?\|?\/?(invoke|parameter|tool_calls?|function_calls?)[^>]*>/gi, ' ');
  // 代码块与行内代码
  text = text.replace(/```[\s\S]*?```/g, ' ');
  text = text.replace(/`([^`]{0,200})`/g, '$1');
  // JSON 外壳（有些模型习惯回 {"say": "..."}）
  const inner = extractSayFromJson(text);
  if (inner !== null) text = inner;
  // 残留的竖线噪音与空标签
  text = text.replace(/[｜|]{2,}/g, ' ');
  text = text.replace(/<[^>\n]{0,40}>/g, ' ');
  return text;
}

function extractSayFromJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (parsed && typeof parsed === 'object') {
        const value = parsed.say ?? parsed.text ?? parsed.content ?? parsed.message;
        if (typeof value === 'string') return value;
      }
    } catch {
      // 不是完整 JSON，落到字面量提取
    }
  }
  const match = /"(?:say|text|content|message)"\s*:\s*"([^"]{0,400})"/.exec(text);
  return match ? match[1] : null;
}

/** 还有没有"这像是工具调用/标记"的痕迹（JSON 外壳不算——那种会先被拆出正文）。 */
function looksLikeToolCall(text) {
  if (!text) return false;
  // 全角/半角竖线噪音（DSML 标记的特征）
  if (/[｜|]{2,}/.test(text)) return true;
  // 尖括号包裹的调用标记：<...invoke...>、</...parameter>、<tool_calls> 等
  if (/<\/?[^<>\n]{0,60}(invoke|parameter|tool_calls?|function_calls?|antml:|DSML)[^<>\n]{0,60}>/i.test(text)) return true;
  // 残留的代码块
  if (/```/.test(text)) return true;
  // 只剩标点/空白的输出也当不可用
  return !/[\u4e00-\u9fa5A-Za-z0-9]/.test(text);
}

function cleanSpacing(text) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'“”「『（(]+/, '')
    .replace(/[\s"'“”」』）)]+$/, '')
    .trim();
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `${seconds} 秒`;
  return `${minutes} 分 ${seconds} 秒`;
}

function errorText(error) {
  if (error && typeof error === 'object' && 'message' in error) return String(error.message);
  return String(error);
}
