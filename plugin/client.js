// client.js —— 浏览器半侧的桌宠 HUD（复用 dsh-pet 的动画素材与气泡外观）。
//
// 契约（见 DSH client-modules）：加载时注册一个惰性 factory，factory 返回插件三件套；
// react 由模块表提供，不打包。所有副作用（样式/定时器/监听）都进 ctx.effect，卸载即回收。
window.__ModuleLoader__.load({
  id: 'dsh-game-pet',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;

    const NS = 'dsh-game-pet';
    const ROUTE = '/dsh-game-pet-7341';
    /** 桌宠动画素材复用 dsh-pet 包里的 webm（插件自带则优先用自己的）。 */
    const PET_ROUTE = '/dsh-pet-7340';
    /** 没有 dsh-pet 时的兜底素材名（放包内 assets/webm/ 即可生效）。 */
    const FALLBACK_SAY = '说';
    const NOT_PLAYING_POLL_MS = 3000;
    /** 台词在屏幕上停留多久 */
    const BUBBLE_MS = 14000;

    const CSS = `
.${NS}-root{position:fixed;left:22px;bottom:22px;z-index:39;width:230px;display:flex;flex-direction:column;
  align-items:flex-start;gap:8px;pointer-events:none;transition:opacity .35s ease;}
.${NS}-root[data-visible="0"]{opacity:0;}
.${NS}-pet{position:relative;width:100%;}
.${NS}-pet video{display:block;width:100%;height:auto;filter:drop-shadow(0 6px 12px rgba(0,0,0,.28));}
.${NS}-fallback{width:100%;aspect-ratio:16/9;border-radius:12px;background:var(--dsw-alias-bg-secondary,rgba(0,0,0,.35));}
.${NS}-chip{display:inline-flex;align-items:center;gap:6px;font-size:11px;line-height:1;
  padding:5px 9px;border-radius:999px;background:var(--dsw-alias-bg-secondary,rgba(0,0,0,.45));
  color:var(--dsw-alias-text-secondary,#ddd);backdrop-filter:blur(6px);}
.${NS}-bubble{position:relative;width:max-content;max-width:min(340px,78vw);box-sizing:border-box;padding:11px 13px;border-radius:14px;
  background:var(--dsw-alias-bg-elevated,rgba(255,255,255,.96));color:var(--dsw-alias-text-primary,#1c1c1e);
  font-size:13.5px;line-height:1.5;box-shadow:0 8px 22px rgba(0,0,0,.22);transition:opacity .25s ease,transform .25s ease;}
.${NS}-bubble[data-on="0"]{opacity:0;transform:translateY(6px);}
.${NS}-bubble::after{content:'';position:absolute;left:26px;bottom:-7px;width:14px;height:14px;
  background:inherit;transform:rotate(45deg);border-radius:3px;}
/* 气泡外观档位：与小窗那边同名同义，只换皮不动结构 */
.${NS}-bubble[data-style="comic"]{background:#fffdf3;color:#221a10;border:2px solid #221a10;border-radius:14px;
  box-shadow:3px 3px 0 0 #221a10;font-weight:600;}
.${NS}-bubble[data-style="comic"]::after{bottom:-9px;width:12px;height:12px;border-right:2px solid #221a10;
  border-bottom:2px solid #221a10;border-radius:0;}
.${NS}-bubble[data-style="glass"]{background:var(--dsw-alias-bg-elevated,rgba(255,255,255,.62));
  color:var(--dsw-alias-text-primary,#1c1c1e);border:1px solid rgba(127,127,127,.28);border-radius:16px;
  backdrop-filter:blur(14px) saturate(1.2);-webkit-backdrop-filter:blur(14px) saturate(1.2);
  box-shadow:0 10px 28px rgba(0,0,0,.18),inset 0 1px 0 rgba(255,255,255,.5);}
.${NS}-bubble[data-style="hud"]{background:rgba(6,18,24,.86);color:#b9ffe9;border:1px solid rgba(64,255,214,.55);
  border-radius:5px;box-shadow:0 0 14px rgba(64,255,214,.3),inset 0 0 18px rgba(64,255,214,.08);
  font-family:"Cascadia Mono",Consolas,monospace;letter-spacing:.3px;}
.${NS}-bubble[data-style="hud"]::after{background:rgba(6,18,24,.86);border:1px solid rgba(64,255,214,.55);}
.${NS}-bubble[data-style="plain"]{background:transparent;box-shadow:none;padding:2px 4px;border-radius:0;
  color:inherit;text-shadow:0 1px 3px rgba(0,0,0,.35);}
.${NS}-bubble[data-style="plain"]::after{display:none;}
.${NS}-say{word-break:break-word;overflow-wrap:anywhere;white-space:normal;}
.${NS}-screen{margin-top:6px;font-size:11px;color:var(--dsw-alias-text-secondary,#6b6b70);word-break:break-word;}
.${NS}-err{margin-top:6px;font-size:11px;color:var(--dsw-alias-text-danger,#c0392b);word-break:break-word;}

/* ── 设置页（settings.section）────────────────────────────────────────── */
.${NS}-cfg{max-width:720px;display:flex;flex-direction:column;gap:14px;
  color:var(--dsw-alias-text-primary,#1c1c1e);font-size:13px;}
.${NS}-cfg__note{font-size:12px;line-height:1.6;color:var(--dsw-alias-text-secondary,#6b6b70);
  background:var(--dsw-alias-bg-secondary,rgba(127,127,127,.08));padding:9px 11px;border-radius:9px;}
.${NS}-card{border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.22));border-radius:11px;
  padding:12px 14px;display:flex;flex-direction:column;gap:11px;}
.${NS}-card__title{font-size:13px;font-weight:600;margin:0;}
.${NS}-row{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;}
.${NS}-row__label{width:132px;flex:0 0 auto;padding-top:5px;color:var(--dsw-alias-text-secondary,#6b6b70);}
.${NS}-row__body{flex:1 1 260px;min-width:220px;display:flex;flex-direction:column;gap:5px;}
.${NS}-hint{font-size:11.5px;line-height:1.55;color:var(--dsw-alias-text-secondary,#8a8a90);}
.${NS}-cfg input[type="text"],.${NS}-cfg input[type="number"],.${NS}-cfg select,.${NS}-cfg textarea{
  width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:13px;
  background:var(--dsw-alias-bg-primary,rgba(255,255,255,.06));
  color:var(--dsw-alias-text-primary,#1c1c1e);
  border:1px solid var(--dsw-alias-border-primary,rgba(127,127,127,.35));outline:none;font-family:inherit;}
.${NS}-cfg textarea{min-height:64px;resize:vertical;line-height:1.5;}
.${NS}-cfg input:focus,.${NS}-cfg select:focus,.${NS}-cfg textarea:focus{
  border-color:var(--dsw-alias-brand-primary,#247bbf);}
.${NS}-switch{display:inline-flex;align-items:center;gap:8px;cursor:pointer;}
.${NS}-switch input{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary,#247bbf);}
.${NS}-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.${NS}-btn{padding:7px 14px;border-radius:8px;font-size:13px;cursor:pointer;font-family:inherit;
  border:1px solid var(--dsw-alias-border-primary,rgba(127,127,127,.35));
  background:var(--dsw-alias-bg-secondary,rgba(127,127,127,.1));
  color:var(--dsw-alias-text-primary,#1c1c1e);}
.${NS}-btn:hover{border-color:var(--dsw-alias-brand-primary,#247bbf);}
.${NS}-btn[disabled]{opacity:.5;cursor:default;}
.${NS}-btn--primary{background:var(--dsw-alias-brand-primary,#247bbf);border-color:transparent;color:#fff;}
.${NS}-pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11.5px;
  background:var(--dsw-alias-bg-secondary,rgba(127,127,127,.12));
  color:var(--dsw-alias-text-secondary,#6b6b70);}
.${NS}-pill--ok{background:rgba(46,160,67,.16);color:#2ea043;}
.${NS}-pill--bad{background:rgba(207,68,68,.16);color:#cf4444;}
.${NS}-out{font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;
  background:var(--dsw-alias-bg-secondary,rgba(127,127,127,.08));padding:9px 11px;border-radius:9px;
  max-height:190px;overflow:auto;}
.${NS}-mono{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;}
.${NS}-list{margin:0;padding-left:18px;font-size:12px;line-height:1.6;}
.${NS}-adv{border:1px dashed var(--dsw-alias-border-secondary,rgba(127,127,127,.28));border-radius:11px;padding:0 14px;}
.${NS}-adv>summary{cursor:pointer;list-style:none;padding:12px 0;font-size:12.5px;font-weight:600;
  color:var(--dsw-alias-text-secondary,#6b6b70);display:flex;align-items:center;gap:8px;}
.${NS}-adv>summary::-webkit-details-marker{display:none;}
.${NS}-adv>summary::before{content:'▸';font-size:11px;transition:transform .15s ease;}
.${NS}-adv[open]>summary::before{transform:rotate(90deg);}
.${NS}-adv__body{display:flex;flex-direction:column;gap:14px;padding-bottom:14px;}
`;

    function installStyles() {
      const existing = document.querySelector(`style[data-plugin-css="${NS}"]`);
      if (existing) return () => {};
      const style = document.createElement('style');
      style.dataset.pluginCss = NS;
      style.textContent = CSS;
      document.head.appendChild(style);
      return () => style.remove();
    }

    function Companion() {
      // 一片状态装全部展示数据（frame = 游戏在不在，bubble = 这次要说的话）。
      // 合成一片是为了只有一个状态槽：这个组件要能被单独测，多片状态让"渲染时到底拿到什么"说不清。
      const [ui, setUi] = useState({ frame: null, bubble: null, look: null });
      const frame = ui.frame;
      const bubble = ui.bubble;
      const look = ui.look;
      const baseline = useRef(null);
      const timer = useRef(null);
      // 已点亮气泡的 at：presence 每秒涨 counter，但同一句话的 at 不变，
      // 只有 at 变了才重置消失计时器，否则气泡永远不消失。
      const shownAt = useRef({ advice: 0, error: 0 });

      // 轮询 /state：counter 变了才处理（与 dsh-pet 同一套协议，前端不需要长连接）
      useEffect(() => {
        let disposed = false;
        let handle = null;
        const poll = async () => {
          let payload = null;
          try {
            const response = await fetch(`${ROUTE}/state`, { cache: 'no-store' });
            if (response.ok) payload = await response.json();
          } catch {
            payload = null;
          }
          if (disposed) return;
          const playing = Boolean(payload?.sections?.presence?.data?.playing);
          handle = window.setTimeout(poll, playing ? 1000 : NOT_PLAYING_POLL_MS);

          if (!payload?.sections) {
            setUi((previous) =>
              previous.frame?.playing ? { ...previous, frame: { ...previous.frame, playing: false } } : previous,
            );
            return;
          }
          if (baseline.current === null) {
            baseline.current = flattenCounters(payload);
            apply(payload);
            return;
          }
          if (!hasChanged(payload, baseline.current)) return;
          baseline.current = flattenCounters(payload);
          apply(payload);
        };

        const apply = (payload) => {
          const presence = payload.sections.presence?.data ?? { playing: false };
          const advice = payload.sections.advice;
          const lastError = payload.sections.lastError?.data;
          // 气泡外观跟小窗共用一套设置：宿主写在 pet 段里（style / fontSize / maxWidth）
          const look = payload.sections.pet?.data ?? null;
          const counter = advice?.counter ?? 0;
          // 用 at 判新鲜度、不用 counter：presence 每秒都在写、counter 一直涨，
          // 若按 hasChanged 重放气泡，BUBBLE_MS 计时器会被无限重置 → 气泡永不消失。
          const adviceAt = advice?.data?.at ?? 0;
          const errorAt = lastError?.at ?? 0;
          const newAdvice = advice && adviceAt > 0 && adviceAt !== shownAt.current.advice && advice.data?.say;
          const newError = lastError && !lastError.ok && lastError.message && errorAt !== shownAt.current.error;
          let bubble = null;
          if (newAdvice) {
            shownAt.current.advice = adviceAt;
            bubble = { ...advice.data, error: null, counter };
          } else if (newError) {
            shownAt.current.error = errorAt;
            bubble = { say: '', screen: '', error: lastError.message, counter: lastError.at ?? Date.now() };
          }
          setUi((previous) => ({ frame: presence, bubble: bubble ?? previous.bubble, look: look ?? previous.look }));
          if (bubble) {
            if (timer.current) window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setUi((previous) => ({ ...previous, bubble: null })), BUBBLE_MS);
          }
        };

        void poll();
        return () => {
          disposed = true;
          if (handle) window.clearTimeout(handle);
          if (timer.current) window.clearTimeout(timer.current);
        };
      }, []);

      const playing = Boolean(frame?.playing);
      // 有话说、或者出错了要报——两者都算"该露脸"（只报错不出声时也得让人看见）
      const visible = playing || Boolean(bubble?.say) || Boolean(bubble?.error);
      const animation = bubble?.animation || '待机呼吸休闲';

      return h(
        'div',
        { className: `${NS}-root`, 'data-visible': visible ? '1' : '0', 'aria-live': 'polite' },
        h(
          'div',
          {
            className: `${NS}-bubble`,
            'data-on': bubble?.say || bubble?.error ? '1' : '0',
            'data-style': look?.style || 'classic',
            // 字号/最大宽度跟随设置；min() 兜住窄窗口，永远不横向溢出
            style: {
              fontSize: `${Number(look?.fontSize) || 13.5}px`,
              maxWidth: `min(${Number(look?.maxWidth) || 340}px, 78vw)`,
            },
          },
          h('div', { className: `${NS}-say` }, bubble?.say ?? ''),
          // 失败原因单独一行、小字（原文照说，不加"没看成"这种前缀；画面描述不进气泡）
          bubble?.error ? h('div', { className: `${NS}-err` }, bubble.error) : null,
        ),
        // 徽章只说游戏名；没在玩就整块不显示（不写"桌宠参谋：待机"这类招牌字）
        playing ? h('div', { className: `${NS}-chip` }, frame?.game || frame?.process || '') : null,
        h(PetSprite, { animation }),
      );
    }

    /**
     * 用一张 <video> 播透明 webm。素材三级回落：本插件自带 assets/webm/<名>.webm
     * → dsh-pet 的 /thumb/main/<名>.webm（复用桌宠素材，默认走这条）
     * → 都没有就画一块占位（气泡照常说话）。
     */
    function PetSprite({ animation }) {
      const sources = [
        `${ROUTE}/anim/${encodeURIComponent(animation)}.webm`,
        `${PET_ROUTE}/thumb/main/${encodeURIComponent(animation)}.webm`,
        `${PET_ROUTE}/thumb/main/${encodeURIComponent(FALLBACK_SAY)}.webm`,
      ];
      const [index, setIndex] = useState(0);
      useEffect(() => {
        setIndex(0);
      }, [animation]);
      if (index >= sources.length) return h('div', { className: `${NS}-fallback`, 'aria-hidden': true });
      const url = sources[index];
      return h(
        'div',
        { className: `${NS}-pet` },
        h('video', {
          key: url,
          src: url,
          autoPlay: true,
          loop: true,
          muted: true,
          playsInline: true,
          onError: () => setIndex((current) => current + 1),
          'aria-hidden': true,
        }),
      );
    }

    function flattenCounters(payload) {
      const flat = {};
      for (const [key, entry] of Object.entries(payload.sections ?? {})) {
        flat[key] = entry?.counter ?? 0;
      }
      return flat;
    }

    function hasChanged(payload, baseline) {
      for (const [key, entry] of Object.entries(payload.sections ?? {})) {
        if ((entry?.counter ?? 0) !== (baseline[key] ?? 0)) return true;
      }
      return false;
    }

    function truncate(text, max) {
      const value = String(text ?? '');
      return value.length > max ? `${value.slice(0, max - 1)}…` : value;
    }

    /**
     * 设置页「桌宠参谋」：所有可视化配置 + 自检。
     * 数据流：GET /config 拿生效值 → 改动就地 POST /config（宿主立即生效并落盘）→
     * 回读宿主归一化后的值，保证界面显示的永远是"真正在跑的那份"。
     */
    /**
     * 桌宠参谋设置页。
     * 直接 iframe 载入网页端 /settings —— 与浏览器版共用同一份 HTML/CSS/JS，
     * 排版 100% 一致、字段永不落后。相对路径会继承 DSH 的 origin+端口，
     * 页面内的 API 逻辑用 location.port 自动拼地址，无需额外配置。
     */
    function SettingsSection() {
      const frameRef = useRef(null);

      // 高度自适应：iframe 同源可直接读内容高度；跨域时保留兜底高度。
      const fitHeight = () => {
        try {
          const frame = frameRef.current;
          const doc = frame?.contentDocument;
          if (doc?.body) frame.style.height = `${Math.max(1400, doc.body.scrollHeight + 24)}px`;
        } catch (_) { /* 跨域，保留兜底高度 */ }
      };

      useEffect(() => {
        const onMessage = (event) => {
          const frame = frameRef.current;
          if (!frame || event.source !== frame.contentWindow) return;
          const data = event.data;
          if (data && data.type === 'dsh-game-pet:height' && typeof data.height === 'number') {
            frame.style.height = `${Math.max(360, Math.min(data.height, 4000))}px`;
          }
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
      }, []);

      return h(
        'div',
        { className: `${NS}-cfg`, style: { maxWidth: 'none' } },
        h('iframe', {
          ref: frameRef,
          src: `${ROUTE}/settings?embed=1`,
          title: '桌宠参谋设置',
          className: `${NS}-frame`,
          style: { width: '100%', minHeight: '420px', border: '0', display: 'block', background: 'transparent' },
          onLoad: fitHeight,
        }),
      );
    }

    return {
      name: 'game-pet',
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(installStyles, 'dsh-game-pet: styles');
        // 只注册设置页。**不再往页面里插浮层**：桌宠住在独立透明置顶小窗里，
        // 网页里再来一个左下角的小人+气泡纯属重复（按用户要求去掉）。
        // 浮层那份实现还在（Companion / PetSprite），要恢复就把下面三行注释放开。
        // ctx.slots.inject('shell.overlay', function* () {
        //   yield ctx.slots.register({ name: 'shell.overlay', id: 'game-pet', order: 900 }, () => h(Companion, {}));
        // });
        ctx.slots.inject('settings.section', function* () {
          yield ctx.slots.register(
            { name: 'settings.section', id: 'game-pet-config', order: 31, label: () => '桌宠参谋' },
            SettingsSection,
          );
        });
      },
    };
  },
});
