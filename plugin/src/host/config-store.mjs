// config-store.mjs —— 用户改过的配置落盘，重启后还记得。
//
// 为什么不用"直接改 cordis.patch.yml"：那是插件行配置（属于代码/组合层，改了要重启；
// 而且用户手写的注释会被覆盖）。设置页的改动进这里，启动时读回来叠在行配置之上：
//   patch 行 config（基础） ← config.json（用户覆盖）
// 这样"设置页改的"和"手写 patch 改的"各归各位，互不破坏。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const HOME = process.env.DSH_HOME || path.join(homedir(), '.dsh');
const CONFIG_FILE = path.join(HOME, 'dsh-game-copilot.json');
// 兼容早期版本：改名前的配置在旧文件里，新文件不存在时继续读它，不丢用户设置。
const LEGACY_CONFIG_FILE = path.join(HOME, 'dsh-game-pet.json');

function readJsonFile(file) {
  try {
    // 去掉 BOM：用户可能用记事本/PowerShell 编辑过这个文件，
    // 带 BOM 的 JSON.parse 会直接抛（踩过：PowerShell 的 utf8 编码会加 BOM）。
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** 读用户覆盖（没有/坏了都返回空对象，绝不抛）。 */
export function readUserConfig() {
  if (existsSync(CONFIG_FILE)) return readJsonFile(CONFIG_FILE);
  return existsSync(LEGACY_CONFIG_FILE) ? readJsonFile(LEGACY_CONFIG_FILE) : {};
}

/** 写用户覆盖（整包写入；始终写新文件；失败只返回 false，不抛）。 */
export function writeUserConfig(patch) {
  try {
    mkdirSync(HOME, { recursive: true });
    const merged = { ...readUserConfig(), ...(patch && typeof patch === 'object' ? patch : {}) };
    // 只要这次写的 patch 里带了 enabled，就说明用户自己表过态（设置页开关）。
    // 记一笔 autoOptIn，默认值迁移以后就不再动他——不能把"用户要开"又给关回去。
    if (Object.prototype.hasOwnProperty.call(patch ?? {}, 'enabled')) merged.autoOptIn = true;
    writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 一次性迁移：把旧版"默认开着"的自动开口改成默认关闭。
 *
 * 旧版（含上游 dsh-game-pet 和 v1.0.1）DEFAULTS.enabled = true，而设置页那张卡
 * 一直标着"默认关"、示例配置也照样写 enabled:true——结果用户从没点过开关，
 * 一装好就每 45 秒自动截屏调模型说话。这里只纠正一次：
 *   存盘配置里 enabled 为 true、且没有 autoOptIn 标记 = 从没表过态，按新默认关掉；
 *   有 autoOptIn 标记（用户在设置页点过）= 他的选择，一律不动。
 * 返回 true 表示这次真改了，调用方据此写一行日志让用户知道为什么变了。
 */
export function migrateAutoSpeakOff() {
  const stored = readUserConfig();
  if (stored.autoOptIn) return false;
  if (stored.enabled !== true) return false;
  return writeUserConfig({ enabled: false });
}

export { CONFIG_FILE };
