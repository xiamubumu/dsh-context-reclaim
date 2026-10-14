/**
 * dsh-context-reclaim — patch notice (client half).
 *
 * WHY THIS FILE EXISTS
 *   The patches this plugin needs cannot be expressed from the plugin layer, and
 *   the server half is a host plugin with no UI at all. So this half renders ONE
 *   dialog, about THIS plugin's patches only, and it explains HOW to apply them
 *   instead of leaving the user to guess.
 *
 * WHAT IT MUST SAY (it is the only place a user learns any of this)
 *   1. which of ITS patches are unapplied, and what each one does;
 *   2. where the tutorial lives, and that the patch library is a separate repo;
 *   3. HOW to apply them, three ways, plus a ready-to-paste prompt for the
 *      user's own agent — in the USER'S language, not always Chinese;
 *   4. which detection system produced the "applied / not applied" verdict, and
 *      that it is a heuristic, so the user knows what they are looking at.
 *
 * HOUSE RULES
 *   · It reads NOTHING belonging to another plugin: its data comes from its own
 *     route (/dsh-context-reclaim/patch-notice), served by its own server half.
 *   · It never applies a patch. It reports and links.
 *   · Already applied, or dismissed => it renders nothing at all.
 *   · Compact window, scrollable body: content is long, the card is not.
 *   · No backticks anywhere in this file.
 */
window.__ModuleLoader__.load({
  id: 'dsh-context-reclaim',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const h = react.createElement;

    const NS = 'dsh-context-reclaim';
    const ROUTE = '/dsh-context-reclaim';
    const STYLE_ID = 'dsh-context-reclaim/patch-notice';

const SETTINGS_KEYS = ['context-reclaim', 'reclaim', 'dsh-context-reclaim'];
    const PATCHLIB_REPO = 'https://github.com/xiamubumu/dsh-patch-library';
    const PATCHLIB_TGZ = PATCHLIB_REPO + '/releases/latest/download/dsh-patch-library-1.0.0.tgz';
    const TUTORIAL = 'tutorial-install-and-official-patches.zh-CN.md';

    /* ------------------------------------------------------------------ *
     * Copy. The dialog speaks the user's language, and so does the prompt it
     * copies — an English user must not be handed a Chinese prompt.
     * ------------------------------------------------------------------ */

    const IDS = 'agent-loop-snapshot-prompt + llm-pi-ai-system-prompt';

    const TEXT = {
      zh: {
        title: '需要官方补丁',
        lead: '下面这些补丁改的是 DSH 官方文件，插件层做不了 —— 所以本插件只报告，绝不替你改。',
        applied: '已打',
        missing: '未打',
        notfound: '未找到文件',
        unknown: '无法判定（文件既不是原版也不是打过版）',
        byHash: '按内容哈希确认',
        byMarker: '按标记串确认（版本有差异）',
        file: '改的文件',
        required: '必须',
        recommended: '建议',
        howto: '怎么打（三种，任选一种）',
        howA: 'A · 交给你的 agent（推荐）：点下面的「复制提示词」，把整段发给它，它自己会看你的真实安装再动手。',
        howB: 'B · 用补丁库的脚本：node apply.mjs --check 先只读体检，node apply.mjs --apply --only <id> 只打你勾的这几条。',
        howC: 'C · 手动 git apply：cd 到被改包的目录，git apply -p1 <补丁库>/patches/<id>/change.diff。',
        tutorial: '教程：插件自带的 ' + TUTORIAL + '（补丁库仓库里也有一份说明与 PROMPT 文件）。',
        detect: '检测系统：按目标文件旁边的 *.orig 备份判断，每次打开界面实时探测。这是启发式 —— 备份被手工删掉会误报「未打」，回滚后备份没清会误报「已打」。',
        copy: '复制提示词',
        copied: '已复制 ✓',
        open: '打开补丁库',
        download: '下载补丁包',
        later: '稍后再说',
        never: '不再提醒',
        hint: '「稍后再说」只关这一次。「不再提醒」是永久的 —— 想让它再出现，删掉下面这个状态文件即可。',
        othersTitle: '其他官方补丁（**不绑定本插件**，按症状决定打不打）',
        othersLead: '这些补丁改的也是 DSH 官方文件，但一条都不属于本插件。列在这里只是为了**不漏** —— 打不打看你自己遇到的情况。',
        stateFile: '提醒的状态文件',
        promptHead: '请帮我给 DSH 打这',
        promptTail: '条官方补丁'
      },
      en: {
        title: 'needs official patches',
        lead: 'The patches below edit official DSH files, which the plugin layer cannot do — so this plugin only reports and never touches them for you.',
        applied: 'applied',
        missing: 'not applied',
        notfound: 'file not found',
        unknown: 'cannot tell (the file is neither the pristine nor the patched version)',
        byHash: 'confirmed by content hash',
        byMarker: 'confirmed by marker (upstream version differs)',
        file: 'file',
        required: 'required',
        recommended: 'recommended',
        howto: 'How to apply them (any ONE of three ways)',
        howA: 'A · Hand it to your own agent (recommended): click "Copy the prompt" below and paste the whole thing — it can see your real installation before touching anything.',
        howB: 'B · Use the patch library script: node apply.mjs --check is a read-only health check, node apply.mjs --apply --only <id> applies only the ones you picked.',
        howC: 'C · Apply by hand: cd into the package being edited and run git apply -p1 <library>/patches/<id>/change.diff.',
        tutorial: 'Tutorial: ' + TUTORIAL + ' ships inside the plugin (the patch library repo also carries the methods doc and the PROMPT files).',
        detect: 'Detection: judged from the *.orig backups next to each target file, re-probed every time the dialog opens. It is a heuristic — a hand-deleted backup reports "not applied", and a rollback that left the backup behind reports "applied".',
        copy: 'Copy the prompt',
        copied: 'Copied ✓',
        open: 'Open the patch library',
        download: 'Download the patch pack',
        later: 'Later',
        never: 'Do not remind me again',
        hint: '“Later” closes this once. “Do not remind me again” is permanent — to bring the notice back, delete the state file below.',
        othersTitle: 'Other official patches (**not owned by this plugin** — apply them by symptom)',
        othersLead: 'These also edit official DSH files but none of them belongs to this plugin. They are listed here purely so nothing goes unseen; whether to apply them is your call.',
        stateFile: 'Notice state file',
        promptHead: 'Please apply these',
        promptTail: 'official DSH patches for me'
      }
    };

    /* The ready-to-paste prompt. Bilingual on purpose: the working language is
       the user's, but the patch ids and paths stay literal so an agent cannot
       mis-transcribe them. */
    function buildPrompt (lang, items) {
      const rows = items.map((item) => '- ' + item.id + '  (' + item.pkg + ' -> ' + item.file + ')').join('\n')
      const ids = items.map((i) => i.id).join(',')
      if (lang === 'zh') {
        return [
          '请帮我给 DSH 打下面 ' + items.length + ' 条官方补丁 —— 用这个补丁库：' + PATCHLIB_REPO,
          '',
          rows,
          '',
          '只打这几条（ids: ' + ids + '），别的不要动。步骤：',
          '1. 先克隆或下载补丁库，cd 进去，跑 node apply.mjs --check 做只读体检，把结果告诉我；',
          '2. 确认后再跑 node apply.mjs --apply --only ' + ids + '；',
          '3. 应用器会自己对每个文件先备份成 .orig、写完后 node --check，失败自动回滚 —— 不要绕过它手工改；',
          '4. 改完告诉我改了哪几个文件、要不要重启 DSH。',
          '',
          '安全红线：只碰 DSH 安装根里的 node_modules，绝不碰 ' + '"$DSH_HOME"' + '（会话与配置）；一次只打一条；任何一条 hunk 对不上就停下来问我，不要猜。'
        ].join('\n')
      }
      return [
        'Please apply the following ' + items.length + ' official DSH patches for me, using this patch library: ' + PATCHLIB_REPO,
        '',
        rows,
        '',
        'Apply ONLY these ids (' + ids + '), nothing else. Steps:',
        '1. Clone or download the library, cd into it, run node apply.mjs --check for a read-only health check and show me the result;',
        '2. After I confirm, run node apply.mjs --apply --only ' + ids + ';',
        '3. The applier backs every file up as .orig first and runs node --check after each write, rolling back on failure — do not hand-edit around it;',
        '4. Tell me which files changed and whether DSH needs a restart.',
        '',
        'Hard rules: only touch node_modules inside the DSH install root, never "$DSH_HOME" (sessions and config); one patch at a time; if any hunk does not match exactly, stop and ask me instead of guessing.'
      ].join('\n')
    }

    function pickLang () {
      try {
        const raw = String(navigator.language || navigator.userLanguage || 'en').toLowerCase();
        if (raw.startsWith('zh')) return 'zh';
      } catch { /* ignore */ }
      return 'en';
    }

    /* ------------------------------------------------------------------ *
     * Styles — compact card, scrollable body.
     * ------------------------------------------------------------------ */

    const CSS = [
      '.dapn-mask{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.42);font-size:12.5px}',
      '.dapn-card{width:min(560px,92vw);max-height:72vh;display:flex;flex-direction:column;background:var(--dsh-color-surface,#fff);color:var(--dsh-color-text,#111);border-radius:12px;box-shadow:0 18px 48px rgba(0,0,0,.28);padding:16px 18px}',
      '.dapn-body{overflow:auto;flex:1 1 auto;padding-right:4px}',
      '.dapn-foot{flex:0 0 auto;padding-top:10px;border-top:1px solid rgba(128,128,128,.22);margin-top:10px}',
      '.dapn-h{font-size:14.5px;font-weight:600;margin:0 0 6px}',
      '.dapn-lead{opacity:.78;line-height:1.55;margin:0 0 10px}',
      '.dapn-row{border:1px solid rgba(128,128,128,.28);border-radius:9px;padding:9px 11px;margin:0 0 8px}',
      '.dapn-row h4{margin:0 0 5px;font-size:13px}',
      '.dapn-meta{opacity:.7;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;margin:0 0 5px;word-break:break-all}',
      '.dapn-why{opacity:.85;line-height:1.55;margin:0 0 6px}',
      '.dapn-sec{margin:12px 0 6px;font-size:13px;font-weight:600}',
      '.dapn-list{margin:0;padding-left:18px;line-height:1.6}',
      '.dapn-list li{margin:3px 0}',
      '.dapn-tag{display:inline-block;border-radius:999px;padding:1px 7px;font-size:11px;margin-left:6px;border:1px solid currentColor}',
      '.dapn-ok{color:#1a8f4a}.dapn-no{color:#c0392b}.dapn-unk{color:#b7791f}',
      '.dapn-acts{display:flex;flex-wrap:wrap;gap:8px}',
      '.dapn-btn{border:1px solid rgba(128,128,128,.45);background:transparent;color:inherit;border-radius:8px;padding:5px 10px;cursor:pointer;font-size:12px}',
      '.dapn-btn.primary{background:var(--dsh-color-primary,#3b6cff);border-color:transparent;color:#fff}',
      '.dapn-hint{opacity:.68;line-height:1.55;margin:8px 0 0}',
      '.dapn-detect{opacity:.72;line-height:1.55;margin:10px 0 0;padding:7px 9px;border-radius:8px;background:rgba(128,128,128,.10)}'
    ].join('');

    function ensureCss () {
      try {
        if (document.getElementById(STYLE_ID) !== null) return;
        const tag = document.createElement('style');
        tag.id = STYLE_ID;
        tag.textContent = CSS;
        document.head.appendChild(tag);
      } catch { /* ignore */ }
    }

    /* ------------------------------------------------------------------ *
     * Transport.
     * ------------------------------------------------------------------ */

    async function fetchNotice () {
      const response = await fetch(ROUTE + '/patch-notice', { headers: { accept: 'application/json' } });
      return await response.json();
    }

    async function postDismiss (dismissed, ids) {
      await fetch(ROUTE + '/patch-notice/dismiss', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dismissed, ids: Array.isArray(ids) ? ids : [] })
      });
    }

    async function openLink (url) {
      try {
        const response = await fetch(ROUTE + '/patch-notice/open', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url })
        });
        const payload = await response.json();
        if (payload !== null && payload.ok === true) return true;
      } catch { /* fall through */ }
      return false;
    }

    function statusOf (item, t) {
      if (item.verdict === 'applied') return { text: t.applied + signalOf(item, t), cls: 'dapn-ok' };
      if (item.verdict === 'missing') return { text: t.missing, cls: 'dapn-no' };
      return { text: item.found === true ? t.unknown : t.notfound, cls: 'dapn-unk' };
    }

    function signalOf (item, t) {
      if (item.signal === 'sha') return ' · ' + t.byHash;
      if (item.signal === 'marker') return ' · ' + t.byMarker;
      return '';
    }

    /* ------------------------------------------------------------------ *
     * The dialog.
     * ------------------------------------------------------------------ */

    function PatchNotice () {
      const lang = pickLang();
      const t = TEXT[lang];
      const [state, setState] = react.useState({ phase: 'loading' });
      const [manual, setManual] = react.useState(null);
      const [copied, setCopied] = react.useState(false);

      react.useEffect(() => {
        ensureCss();
        let alive = true;
        void (async () => {
          try {
            const payload = await fetchNotice();
            if (alive !== true) return;
            const items = payload !== null && Array.isArray(payload.items) ? payload.items : [];
            /* 「不再提醒」按补丁 id 记：关掉的只是**当时已知**的那几条，
               以后出现新的未打补丁，仍然会再提醒（旧版一刀切会永久静音）。 */
            const off = payload !== null && Array.isArray(payload.dismissedIds) ? payload.dismissedIds : [];
            const open = items.some((item) => item.verdict !== 'applied' && off.includes(item.id) !== true);
            setState({
              phase: open ? 'open' : 'done',
              items,
              others: payload !== null && Array.isArray(payload.others) ? payload.others : [],
              stateFile: payload !== null && typeof payload.stateFile === 'string' ? payload.stateFile : null
            });
          } catch {
            if (alive === true) setState({ phase: 'done', items: [] });
          }
        })();
        return () => { alive = false; };
      }, []);

      if (state.phase !== 'open') return null;
      const items = state.items;
      const others = Array.isArray(state.others) ? state.others : [];
      const todo = items.filter((item) => item.verdict !== 'applied');

      const rows = items.map((item) => {
        const st = statusOf(item, t);
        return h('div', { className: 'dapn-row', key: item.id }, [
          h('h4', { key: 'h' }, [
            item.title,
            h('span', { className: 'dapn-tag ' + st.cls, key: 'tag' }, st.text),
            h('span', { className: 'dapn-tag', key: 'tier' }, item.tier === 'required' ? t.required : t.recommended)
          ]),
          h('p', { className: 'dapn-meta', key: 'm' }, item.pkg + ' -> ' + item.file + '   [' + item.id + ']'),
          h('p', { className: 'dapn-why', key: 'w' }, lang === 'zh' ? item.whyZh : item.whyEn)
        ]);
      });

      const body = h('div', { className: 'dapn-body', key: 'body' }, [
        h('p', { className: 'dapn-lead', key: 'lead' }, t.lead),
        ...rows,
        h('p', { className: 'dapn-sec', key: 'h2' }, t.howto),
        h('ul', { className: 'dapn-list', key: 'ul' }, [
          h('li', { key: 'a' }, t.howA),
          h('li', { key: 'b' }, t.howB),
          h('li', { key: 'c' }, t.howC)
        ]),
        h('p', { className: 'dapn-hint', key: 'tut' }, t.tutorial),
        others.length === 0 ? null : h('div', { key: 'others' }, [
          h('p', { className: 'dapn-sec', key: 'oh' }, t.othersTitle + '（' + others.length + '）'),
          h('p', { className: 'dapn-hint', key: 'ol' }, t.othersLead),
          h('ul', { className: 'dapn-list', key: 'oul' }, others.map((o) => {
            const os = statusOf(o, t);
            return h('li', { key: o.id }, o.title + ' — ' + os.text + '  [' + o.id + ']');
          }))
        ]),
        manual === null ? null : h('p', { className: 'dapn-meta', key: 'manual' }, manual),
        h('p', { className: 'dapn-detect', key: 'detect' }, t.detect)
      ]);

      const acts = [
        h('button', {
          key: 'cp',
          type: 'button',
          className: 'dapn-btn primary',
          onClick: () => {
            const text = buildPrompt(lang, todo.length > 0 ? todo : items);
            void navigator.clipboard.writeText(text).then(() => setCopied(true)).catch(() => setManual(text));
          }
        }, copied === true ? t.copied : t.copy),
        h('button', {
          key: 'open',
          type: 'button',
          className: 'dapn-btn',
          onClick: () => { void openLink(PATCHLIB_REPO).then((ok) => setManual(ok ? null : PATCHLIB_REPO)); }
        }, t.open),
        h('button', {
          key: 'dl',
          type: 'button',
          className: 'dapn-btn',
          onClick: () => { void openLink(PATCHLIB_TGZ).then((ok) => setManual(ok ? null : PATCHLIB_TGZ)); }
        }, t.download),
        h('button', {
          key: 'later',
          type: 'button',
          className: 'dapn-btn',
          onClick: () => setState({ phase: 'done', items: [] })
        }, t.later),
        h('button', {
          key: 'never',
          type: 'button',
          className: 'dapn-btn',
          onClick: () => { void postDismiss(true, items.map((i) => i.id)); setState({ phase: 'done', items: [] }); }
        }, t.never)
      ];

      const foot = h('div', { className: 'dapn-foot', key: 'foot' }, [
        h('div', { className: 'dapn-acts', key: 'acts' }, acts),
        h('p', { className: 'dapn-hint', key: 'hint' }, t.hint),
        stateFile === null ? null : h('p', { className: 'dapn-meta', key: 'sf' }, t.stateFile + ': ' + stateFile)
      ]);

      return h('div', { className: 'dapn-mask', role: 'dialog', 'aria-modal': 'true' }, [
        h('div', { className: 'dapn-card', key: 'card' }, [
          h('h3', { className: 'dapn-h', key: 'h' }, NS + ' — ' + t.title),
          body,
          foot
        ])
      ]);
    }

    /* ------------------------------------------------------------------ *
     * Settings card — the permanent switch.
     * ------------------------------------------------------------------ */

    function SettingsCard () {
      const lang = pickLang();
      const [dismissed, setDismissed] = react.useState(false);
      const [ready, setReady] = react.useState(false);
      react.useEffect(() => {
        ensureCss();
        let alive = true;
        void (async () => {
          try {
            const payload = await fetchNotice();
            if (alive !== true) return;
            setDismissed(payload !== null && payload.dismissed === true);
          } catch { /* 读不到就按"没关"显示，开关本身仍然可用 */ }
          if (alive === true) setReady(true);
        })();
        return () => { alive = false; };
      }, []);
      if (ready !== true) return null;
      const label = lang === 'zh'
        ? '不再弹出「官方补丁」提醒（' + IDS + '）'
        : 'Do not show the official-patch notice (' + IDS + ')';
      return h('label', { className: 'dapn-row', style: { display: 'block', cursor: 'pointer' } }, [
        h('input', {
          key: 'i',
          type: 'checkbox',
          checked: dismissed,
          style: { marginRight: '8px' },
          onChange: (event) => {
            const next = event.target.checked;
            setDismissed(next);
            void postDismiss(next);
          }
        }),
        h('span', { key: 's' }, label)
      ]);
    }

    function apply (ctx) {
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: NS + '-patch-notice',
        order: 90
      }, PatchNotice));

      /* 候选设置命名空间全注册一遍：宿主用的名字未必等于包名
         （见文件头注释），keyed 槽位只有匹配上的那个会渲染。 */
      for (const key of SETTINGS_KEYS) {
        ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
          name: 'settings.plugin.item',
          key,
          id: NS + ':' + key
        }, SettingsCard));
      }
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    exports.NS = NS;
    exports.PatchNotice = PatchNotice;
    exports.SettingsCard = SettingsCard;
    exports.buildPrompt = buildPrompt;
    return module.exports;
  }
});
