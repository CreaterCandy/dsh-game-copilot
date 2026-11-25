// http-llm.mjs —— 两个模型槽位共用的 HTTP 入口 + 数字探针。
//
// 底层请求复用 vision-api.mjs（OpenAI / Anthropic 两种协议已经在那里调通），
// 这一层只做三件事：
//   1. chat({ api, system, prompt, image }) —— 带图走一步式，不带图走纯文本；
//   2. runProbe() —— 随机 4 位数字小图，判断这个端点到底能不能看图；
//   3. 统一 re-export 脱敏/检测函数，设置页只认这一个文件。
//
// 探针图纯 Node 标准库生成（zlib + 手写 CRC32），不 spawn Python——
// 即使只装了 DSH 插件、还没建 venv，也能探。runtime/probe_digits.py 是同一套
// 规则的命令行版，供自检用；两边都是 5x7 点阵、64x64、4 位数字。

import { deflateSync } from 'node:zlib';
import {
  askWithCustomApi,
  chatWithCustomApi,
  describeWithCustomApi,
  customVisionReady,
  redactVisionApi,
  testCustomApi,
} from './vision-api.mjs';

// ── PNG 编码（8bit 灰度，无外部依赖）────────────────────────────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(kind, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(kind, 'ascii'), data])), 0);
  return Buffer.concat([length, Buffer.from(kind, 'ascii'), data, crc]);
}

const FONT = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
};

/** 生成一张 64×64 白底黑字的随机 4 位数字 PNG。 */
export function makeProbeImage() {
  const code = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  const size = 64;
  const scale = 2;
  const gap = scale;
  const rows = Array.from({ length: size }, () => new Uint8Array(size).fill(255));
  const glyphW = 5 * scale;
  const glyphH = 7 * scale;
  const totalW = 4 * glyphW + 3 * gap;
  const x0 = Math.floor((size - totalW) / 2);
  const y0 = Math.floor((size - glyphH) / 2);

  for (let index = 0; index < 4; index += 1) {
    const bitmap = FONT[code[index]] ?? FONT['0'];
    const dx = x0 + index * (glyphW + gap);
    for (let gy = 0; gy < 7; gy += 1) {
      for (let gx = 0; gx < 5; gx += 1) {
        if (bitmap[gy][gx] !== '1') continue;
        for (let sy = 0; sy < scale; sy += 1) {
          const row = rows[y0 + gy * scale + sy];
          for (let sx = 0; sx < scale; sx += 1) row[dx + gx * scale + sx] = 0;
        }
      }
    }
  }

  const raw = Buffer.alloc((size + 1) * size);
  for (let y = 0; y < size; y += 1) {
    rows[y].forEach((value, x) => {
      raw[y * (size + 1) + 1 + x] = value;
    }); // 每行首字节 0 = PNG filter "none"
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  return {
    code,
    png: Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', deflateSync(raw, { level: 9 })),
      pngChunk('IEND', Buffer.alloc(0)),
    ]),
  };
}

/** 回复里含这 4 位数就算真看到了；容忍 "48 21" 这类分隔。 */
export function probePassed(text, code) {
  const compact = String(text ?? '').replace(/\D/g, '');
  return compact.includes(code);
}

/**
 * 跑一次探针。
 * 400 / 415 / 答错 / 超时一律按 no；超时额外标 timeout 供设置页提示。
 * @returns {Promise<{status:'yes'|'no', code:string, detail?:string, timeout?:boolean}>}
 */
export async function runProbe({ api, timeoutMs = 20000 }) {
  if (!customVisionReady(api)) return { status: 'no', code: '', detail: '端点或模型没填' };
  const { code, png } = makeProbeImage();
  const result = await describeWithCustomApi({
    api,
    image: png,
    prompt: '这张图上有 4 位数字。只回答那 4 位数字，不要解释。',
    timeoutMs,
  });
  if (!result.ok) {
    return {
      status: 'no',
      code,
      detail: result.message,
      timeout: /超时|timeout|abort/i.test(result.message),
    };
  }
  return {
    status: probePassed(result.text, code) ? 'yes' : 'no',
    code,
    detail: String(result.text).slice(0, 80),
  };
}

/** 统一对话入口：有图走一步式，无图走纯文本。两个槽位都用它。 */
export async function chat({ api, system, prompt, image, imageType, timeoutMs, maxTokens }) {
  if (image && image.length > 0) {
    return askWithCustomApi({ api, system, image, imageType, prompt, timeoutMs, maxTokens });
  }
  return chatWithCustomApi({ api, system, prompt, timeoutMs, maxTokens });
}

export async function describe({ api, image, prompt, timeoutMs }) {
  return describeWithCustomApi({ api, image, prompt, timeoutMs });
}

export const apiReady = customVisionReady;
export const redactApi = redactVisionApi;
export const testApi = testCustomApi;
