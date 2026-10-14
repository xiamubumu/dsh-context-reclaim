/**
 * dsh-context-reclaim —— 创建时的上下文回收（无损净化 + 按内容类型有界）
 *
 * 版本 0.2.0：在 0.1.0 的「无损噪声净化」之上加上**方向 2 收尾**：
 * **按内容类型分级有界 + 取回指针**。
 *
 * ────────────────────────────────────────────────────────────────────────
 * 一、为什么"创建时"是唯一缓存安全的位置
 * ────────────────────────────────────────────────────────────────────────
 * 实测（'<工作区>\tests\measure_toolresult_by_type.mjs'，117 个会话）：
 *   · tool/result 共 **36,444 条 / 57.1 MB**
 *   · **可重跑**（pwsh 等）      16,325 条 / 27.6 MB / **48.4%**
 *   · **源在磁盘**（read/grep/glob）7,555 条 / 22.7 MB / **39.9%**（read 平均仅 3,549 字节）
 *   · 不可复现（web_fetch/job_output…）764 条 / 3.3 MB / 5.8%
 *   · 参数即内容（write/edit）   9,411 条 / 0.9 MB / 1.6%  ← 这是**结果**，不是参数
 *   ⇒ **88.3% 落在"可分级"的两类里。**
 *
 * 而且实测发现：**官方在"创建时"根本没有做有界**。
 * '@deepseek-ai/dsh-compaction-tool-result-pruner' 的 'pruneSession()' 遍历
 * 'session.surface.nodes' 做 **replace**（= 改写已进历史的消息），**只在压缩时跑**；
 * 所以 'read' 单条 60,038 字节会被原样存进历史。
 * （'dsh-spill-policy' 只在 >50KB 时落盘，管不到 8KB–50KB 这一段。）
 *
 * 本插件的做法：**只在结果"刚产生、还没进历史"时**处理。
 * 'tools/post-execute' 时消息尚未提交 ⇒ 表面仍是纯追加 ⇒ **不打断前缀缓存**。
 * 一旦进了历史就**绝不再碰**（那是方向 3「整段折叠」，yaml 'do_not_do' 明禁）。
 *
 * ────────────────────────────────────────────────────────────────────────
 * 二、四类内容（参数全部抄 '完整方案-上下文治理.yaml' 的 parameters 段）
 * ────────────────────────────────────────────────────────────────────────
 * | 类型 | 例子 | 处理 | 参数出处 |
 * |---|---|---|---|
 * | **源在磁盘** | read / grep / glob | 有界 + **"怎么看全文"的指针** | 'readOnlySnip'（Reasonix prune.go） |
 * | **可重跑** | pwsh / bash | 有界（更宽，副作用输出不一定能重放） | 'sideEffectingSnip'（Reasonix prune.go） |
 * | **不可复现** | web_fetch / job_output / 错误结果 | **必须保真，一个字节都不动** | yaml 方向 2 表 |
 * | **参数即内容** | write / edit |  **本插件做不到**（见下） | — |
 *
 *  'write'/'edit' 的**参数**（历史里的整份文件内容）**无法在创建时有界**
 *   实测 '<APP_ROOT>\node_modules\@deepseek-ai\dsh-agent-loop\lib\index.js:1181'
 *   —— 'assistant/message'（含全部工具入参）在**流结束、工具执行之前**就已写入 session。
 *   等 'tools/execute' / 'tools/post-execute' 能插手时，整份内容**已经在历史里了**。
 *   ⇒ 改它就得改写历史 ⇒ 毁前缀。**故本插件不碰它。**
 *
 * ────────────────────────────────────────────────────────────────────────
 * 三、两道门（各自独立，别混）
 * ────────────────────────────────────────────────────────────────────────
 * · **噪声净化**（无损）：门槛 'saved ≥ 32 字符 且 ≥ 0.2%'。比例低是因为单条噪声本来就少，
 *   门槛高了会让这个功能什么都不做。
 * · **有界**（有信息损失）：门槛 '省 > 5%'（yaml 'noOpGuardRatio: 0.05'，出处 dsh-argp）。
 *   切行是有损的，不值得为 5% 以下收益动结果。
 *
 * 其余纪律：错误结果永不剪 / 已被替换过值的不抢 / >maxInlineBytes 交给官方 spill /
 * 任何异常 fail-open（绝不把成功调用变成失败）。
 *
 * 安全阀（环境变量）：DSH_RECLAIM_NOISE=0 关噪声；DSH_RECLAIM_BOUNDED=0 关有界；
 * DSH_RECLAIM_STRIP_LINES=1 开有损的进度行过滤。
 *
 * 不含反引号（沿用本项目客户端 bundle 纪律）。
 */

/* ══════════════ 一、无损噪声净化（0.1.0 原有） ══════════════ */

/** 无损净化：ANSI 转义序列。 */
const ANSI = /\u001b\[[0-9;?]*[a-zA-Z]/g
/** 无损净化：行尾空白（含 \t）。 */
const TRAILING_WS = /[ \t]+$/gm
/** 无损净化：连续空行压成一个（终端显示本来就看不出 3 个空行与 1 个的区别）。 */
const BLANK_RUN = /\n{3,}/g
/** 有损：进度/百分比行。默认关。 */
const PROGRESS_LINE = /^.*\b\d{1,3}%.*$/gm
/** 有损：git 对象计数行。默认关。 */
const GIT_COUNT_LINE = /^(?:Enumerating|Counting|Compressing|Receiving|Writing) objects:.*$/gm

/**
 * 把回车刷屏折成最后一帧（终端语义：\r 回车覆写同一行）。
 * 逐行处理，避免跨行走。
 * @param text - 原始文本。
 * @returns 折过帧的文本。
 */
function collapseCarriageReturns(text) {
  /* 类型守卫：只处理字符串。调用方 purify 已守卫，这里再守一次 ——
     边缘输入（Symbol / 数字 / 对象）不该让插件抛错，哪怕当前调用链走不到。 */
  if (typeof text !== "string") return ""
  if (text.length === 0 || !text.includes("\r")) return text
  return text
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line
      const parts = line.split("\r")
      // 找最后一个非空片段（终端渲染出来就是它）
      for (let i = parts.length - 1; i >= 0; i -= 1) {
        if (parts[i].length > 0) return parts[i]
      }
      return ""
    })
    .join("\n")
}

/* ══════════════ 二、按内容类型分级 ══════════════ */

/**
 * **源在磁盘**的工具：结果可以从磁盘原样再取回 ⇒ 有界是安全的。
 * 取回指针直接给 'read <path> offset=N limit=M'。
 */
const READ_ONLY_TOOLS = [
  "read", "grep", "glob", "search_files", "list_dir", "read_file", "view_file",
  "codegraph_explore", "codegraph_node", "codegraph_callers", "codegraph_callees",
  "lsp_diagnostics", "lsp_symbols", "lsp_workspace_symbols",
]

/**
 * **可重跑 / 有副作用**的工具：命令重跑一次就能再拿到输出 ⇒ 可以有界，
 * 但给得比 readOnly 宽（Reasonix 的 'sideEffectingSnip' 就是更宽），
 * 因为副作用命令的输出**不一定能重放出同样的字节**。
 */
const SIDE_EFFECT_TOOLS = [
  "pwsh", "powershell", "bash", "sh", "shell", "run_command", "exec", "cmd",
  "docker_logs", "docker_exec", "docker_inspect", "docker_ps",
  "agent_teams_status", "job_output", "job_list",
]

/**
 * **不可复现**的工具：输出转瞬即逝 / 来自外部世界 ⇒ **必须保真**，一个字节都不动。
 * 宁可多花 token，也不能让模型基于残缺信息下判断。
 */
const FAITHFUL_TOOLS = [
  "web_fetch", "web_search", "computer_screenshot", "screen_observe", "screen_zoom",
  "knowledge_read", "knowledge_search", "read_image",
  "agent_teams_claim_task", "pilot_snapshot",
]

/** yaml 'parameters' 段的取值；config 可覆盖。 */
const CAP_DEFAULTS = {
  /** 'readOnlySnip'（Reasonix 'prune.go'）：头 80 行 / 尾 12 行。
   *    P1-2：字符上限从 10000/2000 下调到 **8192/1024**（对齐生态共识 ——
   *  官方 pruner 就是 8192/4096/1024，430 个包的机制指纹里 14~17 个包原样采用）。
   *  且 'bound' 的"够大"判据同时看**行数与字符** ⇒ 少行但超长的结果也会被剪。 */
  readOnly: { headLines: 80, tailLines: 12, headChars: 512, tailChars: 160 },
  /** 'sideEffectingSnip'（Reasonix 'prune.go'）：头 40 / 尾 40。
   *    重大修正（实测发现"工具结果立马就上来了"）：
   *  原值 headChars 8000 / tailChars 8000（readOnly 8192/1024）把**触发点**定在 9,216~16,000 字符，
   *  于是 **8K~16K 的工具结果全部原样放过** —— 而那正是最常见的一档。
   *  实测证据（真实会话 58 条工具结果 / 161,820 字符 ≈ 44,950 tok）：
   *    48,904 字符那条**压过了**（>16K）；而 14,628 / 12,390 / 7,860 / 5,566 / 4,305 / 3,976 …
   *    共 19 条**一条都没压**（都 <16K）⇒ 22 条超 1500 字符的里 19 条没压，占全部字符的 89%。
   *  官方对标：<APP_ROOT>\node_modules\@deepseek-ai\dsh-compaction-tool-result-pruner
   *    lib/index.js 里对"可复现工具"用的是 **AGGRESSIVE_THRESHOLD_CHARS = 1024**（比它宽 8~16 倍）。
   *  ⇒ 第一轮调成 readOnly 2048+512（触发点 2,560）、sideEffect 4096+1024（触发点 5,120）；
   *   * 第三轮（ 夜，对齐 630 包）：630 包的 gate.ts 门控就是 "**超 512 字符的 tool result**"
   *     （见 <工作区>\context-plugins-src\packages\dsh-argp@1.3.0\package\README.md 核心机制 §Stage-1），
   *     比官方 pruner 的 AGGRESSIVE_THRESHOLD_CHARS=1024 更激进。本插件有精确指针可 read 回 ⇒ 对齐它：
   *     readOnly 512+160（触发点 672）· sideEffect 1024+256（触发点 1,280）。
   *   * 第二轮实测（132 轮会话：工具结果 152 项 / 60.1k tok）后**再降一档**到
   *     readOnly 1024+256（触发点 1,280）、sideEffect 2048+512（触发点 2,560）——
   *     平均 395 tok/项 ⇒ 再降约一半。安全性不变（同样带精确指针/可重跑）。
   *  安全性：这两类工具的输出**都能拿回来**（read 带精确指针 / 命令可重跑）⇒ 有界不损失信息。 */
  sideEffect: { headLines: 40, tailLines: 40, headChars: 1024, tailChars: 256 },
}

/** 该工具属于哪一类。判据是**白名单**，认不出的一律保真（保守派）。 */
function kindOf(toolName, cfg) {
  const name = String(toolName ?? "")
  const fa = Array.isArray(cfg?.faithfulTools) ? cfg.faithfulTools : FAITHFUL_TOOLS
  if (fa.includes(name)) return "faithful"
  const ro = Array.isArray(cfg?.readOnlyTools) ? cfg.readOnlyTools : READ_ONLY_TOOLS
  if (ro.includes(name)) return "readOnly"
  const se = Array.isArray(cfg?.sideEffectTools) ? cfg.sideEffectTools : SIDE_EFFECT_TOOLS
  if (se.includes(name)) return "sideEffect"
  // 不在任何名单里 ⇒ 当保真处理（宁可不动）
  return "faithful"
}

/** 从 '<path>…</path>' 信封里取路径，用于生成 read 取回指针。 */
function pathOfEnvelope(text) {
  const m = /<path>([^<]+)<\/path>/.exec(text)
  return m === null ? undefined : m[1].trim()
}

/**
 * 有界：保留**头 N 行 + 尾 M 行**，中间换成一行指针。
 *
 * 为什么用"行"而不是纯字符：'read' 的结果带 '行号: 内容' 前缀，按行切才能让
 * 指针里的 'offset=N limit=M' 直接对得上；纯字符切会把行号切半。
 * 但对超长单行再做字符兜底，避免"80 行里有 60 万字符"绕过上限。
 *
 * @param text - 原始文本。
 * @param cap - '{ headLines, tailLines, headChars, tailChars }'。
 * @param pointer - 指针提示（已含如何取回全文的说明）。
 * @returns 有界后的文本，或 null（无需处理）。
 */
/**
 * 失败/错误标记 —— 被省略区域里出现这些，**必须点名**。
 *
 * ═══ 为什么需要研-04 的直接产物）═══
 * Reasonix 的 benchmarks\compaction\probes.go 里有个 buriedTestLog() 探针，
 * 它**故意**造出一条这样的测试日志（原文形状）：
 *     前 120 行   --- PASS: TestEmitterCase000..119
 *     第 122 行       emitter_test.go:412: assertion failed: expected beta-7d21, got gamma-4a88   <- 唯一失败细节
 *     第 123 行   --- FAIL: TestEmitterQuoting (0.01s)
 *     后 80 行    --- PASS: ...
 *     末尾        FAIL / exit status 1
 * 它自己的注释写着：
 *     "Geometric snipping keeps the first 80 and last 12 lines, so this is precisely
 *      the shape it drops while reporting a plausible-looking remainder."
 *     "they score the maintenance pass rather than the fold: every other probe in the
 *      suite is short enough that snipping cannot touch it."
 *
 * **而 headLines: 80 / tailLines: 12 正是本插件的默认值。**
 * => 几何切会**恰好丢掉中间那唯一的失败细节**，而留下的头尾看起来"很正常"。
 *
 * 修法（**无损**）：切之前先扫一遍**被省略区域**，把失败行**在 marker 里点名**
 * （行号 + 内容前 80 字符，最多 5 条）。这样模型知道"中间有个失败、在第 122 行"，
 * 而不是看到一个"全是 PASS"的假象。成本只有几十 token。
 */
/**
 *  用 i 标志（大小写不敏感）—— 实测踩过：不带 i 时 ERROR: 匹配不到（只认 Error）。
 *
 *  ** 第二次修：第一版太窄，10 条真实形状语料里漏掉 7 条。**
 *   由 G-18（<工作区>\tests\verify_no_silent_loss.mjs）抓出。漏掉的真实形状：
 *     · E   AssertionError: ledger drift 0.05 CNY —— \berror\b\s*: 要求 error 前是词边界，
 *        而 AssertionError 里的 Error 前面是 n ⇒ **不匹配**
 *     · [ERROR] Failed to execute goal on project risk-engine:jar:3.2.1 —— ERROR 后紧跟 ] 不是冒号 ⇒ 不匹配
 *     · npm WARN audit 3 high severity vulnerabilities in openssl-src@1.2.3 —— 无任何关键词
 *     · Cannot find path 'D:\\...\\ctp_secret.json' because it does not exist. —— 无关键词
 *     · deadbeef fix(risk): correct margin ratio 0.115 -> 0.108 —— 无关键词
 *   ⇒ 修法：① 去掉"必须紧跟冒号"；② 加 AssertionError/Failed/Cannot find/does not exist/
 *     WARN/deprecated/vulnerabilit/refused/timeout/drift/FAILED/[ERROR] 等真实形状；
 *     ③ 把 error/exception 的匹配从"必须带冒号"放宽到"作为独立词出现"，
 *        但**排除**了会大面积误伤的 \w+Error 之外的普通叙述（见下方负向断言）。
 *   中文那三个词仍**必须在行首 + 冒号**（否则中文日志里"失败"两个字遍地都是 ⇒ marker 会膨胀）。
 */
const FAILURE_MARK = new RegExp(
  '('
  + '\\bFAIL\\b|^---\\s*FAIL|assertion failed|assertionerror|\\bfailed\\b'
  + '|expected .{0,40}got |\\berror\\b|\\bexception\\b|\\btraceback\\b|\\bpanic:|\\bfatal\\b'
  + '|caused by|cannot find|does not exist|\\brefused\\b|\\btimeout\\b|\\bdrift\\b'
  + '|\\bWARN\\b|\\bdeprecated\\b|vulnerabilit|exit status [1-9]|✗|❌'
  + ')'
  + '|(^[ \\t]*(?:错误|失败|异常)[ \\t]*[:：])',
  'i',
)
/** 最多点名几条失败行（防 marker 自己变长）。 */
const FAILURE_HIGHLIGHT_LIMIT = 5

/**
 * 从被省略区域里挑出失败/错误行，返回"第 N 行 内容"的短串数组。
 * @param lines - 全文按行切好的数组。
 * @param from - 被省略区域的起始下标（0-based，含）。
 * @param to - 被省略区域的结束下标（0-based，不含）。
 * @param limit - 最多几条。
 */
function failureHighlights(lines, from, to, limit) {
  const out = []
  for (let i = from; i < to && i < lines.length; i += 1) {
    const raw = lines[i]
    if (typeof raw !== "string") continue
    const t = raw.trim()
    if (t.length === 0) continue
    if (!FAILURE_MARK.test(t)) continue
    out.push("L" + (i + 1) + " " + (t.length > 80 ? t.slice(0, 80) + "…" : t))
    if (out.length >= limit) break
  }
  return out
}

/**
 *  A-14：从被省略区域里抽 **JSON 字面量**（JSON 字面量 k: v），点名保留。
 *
 * ═══ 为什么（研-03 的产物）═══
 * <工作区>\context-plugins-src\packages\dsh-context-management@0.1.1\package\dist\chunk-ZV76NGFN.js:3538
 * 的 windowEvidenceIndex() 用一个正则从**工具结果**里抽字面量：
 *     /"[^"\\\r\n]{1,80}"\s*:\s*(?:"(?:\\.|[^"\\\r\n]){0,240}"|-?\d+(?:\.\d+)?|true|false|null)/g
 * 它的 header 原文：
 *     "Earlier source records (quoted historical data). Later user amendments take precedence.
 *      Values are literal strings: c…"
 *
 * **为什么这一招对**：端口号、路径、开关、版本号正是"几何切"最容易丢掉、
 * 而模型摘要最容易"概括掉"的东西（把 "port": 8080 说成"某个端口"）。
 * 而**正则抽取是零风险的** —— 原文照抄，不解释、不概括。
 *
 * ═══ 与已有的 A-10 分工 ═══
 *   · A-10 点名的 failureHighlights：抓**测试日志里的失败细节**（英文 keyword + 行首中文）
 *   · A-14 这里的 literalHighlights：抓**配置/响应里的键值对**（JSON 字面量 k: v）
 * 两者互补，都在**同一个 marker** 里，成本各几十~两百字符，都**无损**（原文照抄 + 指针）。
 *
 *  刻意**不复用**它的正则：那条要求 key 必须带双引号（JSON 风格），
 * 而工具结果里更常见的是 YAML/INI 风格的 key: value（无引号）与 key=value。
 * 这里用更宽的两条，但**限制行长 ≤120**（防把文章式文本里的冒号当成键值对）。
 */
const LITERAL_MARK_JSON = /"[^"\\\r\n]{1,80}"\s*:\s*(?:"(?:\\.|[^"\\\r\n]){0,200}"|-?\d+(?:\.\d+)?|true|false|null)/g
/**
 *  ** 第三次修：值模式太窄，漏掉"无引号但含数字/斜杠"的值。**
 *   由 G-18（<工作区>\tests\verify_no_silent_loss.mjs）抓出：k8s 清单里的
 *     image: registry.local/veighna-api:2026.09.22-rc3
 *   值以字母开头 ⇒ 旧的 -?\d+…|"…"|'…'|[A-Za-z]:\…|\/… 全不匹配 ⇒ **整行不被点名**。
 *   修法：把最后一条从"绝对路径 /…"放宽为**"含数字或分隔符的裸 token"**。
 *   这样既覆盖 2026.09.22-rc3 / registry.local/x:tag / 1.2.3，
 *   又不会让纯英文散文（key: some plain words）变成候选 ⇒ 控制噪音。
 */
const LITERAL_MARK_KV = /(?:^|[\s,{[(])([A-Za-z_][A-Za-z0-9_.-]{1,40})\s*[:=]\s*(-?\d+(?:\.\d+)?|true|false|null|"[^"\r\n]{1,120}"|'[^'\r\n]{1,120}'|(?=[^\s"']{2,120}(?:\s|$))(?=[^\s"']*(?:[0-9]|[/\\.])[^\s"']*)[^\s"']{2,120})/g
/** 最多点名几条字面量（防 marker 自己变长）。 */
const LITERAL_HIGHLIGHT_LIMIT = 6
/** 单条字面量的展示长度上限。 */
const LITERAL_MAX_LEN = 90

/**
 * 从被省略区域里抽"键值/字面量"，返回短串数组（形如 第 123 行 "port": 8080）。
 *
 *  ** 第二次修：第一版是"先到先得"，被 filler 占满名额。**
 *   由 G-18（<工作区>\tests\verify_no_silent_loss.mjs）抓出，证据：
 *     JSON 配置语料里被省略区含 "filler_77": 77 … "filler_82": 82 **6 个填充键**，
 *     它们把 6 个名额全占满，而**真正的 "tdp_port": 7709 一个字都没被点名**。
 *   ⇒ 修法（**先收集全部候选、再按信息量排序取前 N**，而不是边走边取）：
 *     ① 统计每个 key 在被省略区出现的次数 —— **反复出现的低信息量**（filler/分页/序号）
 *     ② 值的信息量打分：长的带引号串 / 路径 / 版本号 / 端口（≥3 位数）⇒ 高分；纯小整数 ⇒ 低分
 *     ③ 综合排序：**罕见 key 优先**，同罕见度则**信息量高的优先**
 *   ⇒ 这样 "tdp_port": 7709（key 只出现 1 次、值是端口）必然排在 "filler_77": 77 之前。
 *
 * @param lines - 全文按行切好的数组。
 * @param from - 被省略区域的起始下标（0-based，含）。
 * @param to - 被省略区域的结束下标（0-based，不含）。
 * @param limit - 最多几条。
 */
function literalHighlights(lines, from, to, limit) {
  /** 候选：{ line, key, text, score } */
  const cands = []
  const keyCount = new Map()
  for (let i = from; i < to && i < lines.length; i += 1) {
    const raw = lines[i]
    if (typeof raw !== "string") continue
    const t = raw.trim()
    /* 限制行长：真正的键值对不会很长；长行多半是散文，冒号不是键值分隔符。 */
    if (t.length === 0 || t.length > 120) continue
    let key = null
    let hit = null
    LITERAL_MARK_JSON.lastIndex = 0
    const mj = LITERAL_MARK_JSON.exec(t)
    if (mj !== null) {
      hit = mj[0]
      key = (hit.match(/^"([^"]+)"/) ?? [])[1] ?? null
    } else {
      LITERAL_MARK_KV.lastIndex = 0
      const mk = LITERAL_MARK_KV.exec(t)
      if (mk !== null) {
        key = mk[1]
        hit = (mk[1] + ": " + mk[2])
      }
    }
    if (hit === null) continue
    if (key !== null) keyCount.set(key, (keyCount.get(key) ?? 0) + 1)
    cands.push({ line: i + 1, key, text: hit })
  }
  if (cands.length === 0) return []

  /** 值的信息量打分（越高越值得点名）。 */
  const valueScore = (text) => {
    const v = String(text.split(/[:=]/).slice(1).join(":")).trim()
    let s = 0
    if (/^["']/.test(v)) s += 6                     /* 带引号 ⇒ 多半是字符串配置 */
    if (/[\\/]/.test(v)) s += 8                     /* 路径 */
    if (/\d+\.\d+/.test(v)) s += 5                  /* 版本号/小数 */
    if (/-[a-z0-9]+/i.test(v)) s += 3               /* rc3 / snapshot 之类后缀 */
    const num = Number(v.replace(/["']/g, ""))
    if (Number.isFinite(num)) {
      s += Math.abs(num) >= 100 ? 6 : Math.abs(num) >= 10 ? 2 : 0   /* 端口/大数字 > 小序号 */
    }
    s += Math.min(10, Math.floor(v.length / 6))     /* 长度本身有一点信息量 */
    return s
  }

  /* 排序：罕见 key 优先（次数升序）→ 信息量高优先 */
  cands.sort((a, b) => {
    const ca = a.key === null ? 1 : (keyCount.get(a.key) ?? 1)
    const cb = b.key === null ? 1 : (keyCount.get(b.key) ?? 1)
    if (ca !== cb) return ca - cb
    return valueScore(b.text) - valueScore(a.text)
  })

  const out = []
  const seen = new Set()
  for (const c of cands) {
    const short = c.text.length > LITERAL_MAX_LEN ? c.text.slice(0, LITERAL_MAX_LEN) + "…" : c.text
    /* 去重：同一配置在多个工具结果里重复出现很常见，只点名一次。 */
    if (seen.has(short)) continue
    seen.add(short)
    out.push("L" + c.line + " " + short)
    if (out.length >= limit) break
  }
  return out
}

/**
 * 从头按行累加，**永不切在半行中间**（ P2-2，学 Pi 的 harness/utils/truncate.js）。
 * 至少保留一行（哪怕单行就超过 maxChars）—— 比"返回空"更有用。
 * @param lines - 已按 \n 切好的行。
 * @param maxLines - 最多保留几行。
 * @param maxChars - 字符上限（近似字节预算）。
 * @returns 头部的文本块。
 */
function takeHeadLines(lines, maxLines, maxChars) {
  const out = []
  let used = 0
  for (let i = 0; i < lines.length && i < maxLines; i += 1) {
    const add = out.length === 0 ? lines[i].length : lines[i].length + 1
    if (out.length > 0 && used + add > maxChars) break
    out.push(lines[i])
    used += add
  }
  return out.join("\n")
}

/** 从尾按行累加（方向相反，同样不切半行、至少保留一行）。 */
function takeTailLines(lines, maxLines, maxChars) {
  const out = []
  let used = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i -= 1) {
    const add = out.length === 0 ? lines[i].length : lines[i].length + 1
    if (out.length > 0 && used + add > maxChars) break
    out.unshift(lines[i])
    used += add
  }
  return out.join("\n")
}

/**
 *：**省略区抽样点名** —— 解决"已知边界"（认不出形状的事实被静默丢弃）。
 *
 * 背景：门禁 G-18 用 10 条真实语料测"绝不静默丢失"，其中 3 条属于**认不出形状**的：
 *   git log 里的 "margin ratio 0.115 -> 0.108"、docker ps 里的容器名 "veighna-md"、
 *   CSV 里的异常行 "9999,12345"。它们既没有失败关键词、也不是 key:value ⇒ 老的
 *   failureHighlights / literalHighlights **点不到名** ⇒ 剪掉后模型完全看不到（静默丢失）。
 *
 * 解法：从被省略的那段里**等间隔取 K 行**（默认 12）连同行号写进标记 —— 不猜测、不判定，
 * 任何形状的事实都有机会被看到。三个性质：
 *   · **确定性**：同一输入永远同一输出（按行号等间隔，不随机）⇒ 不破缓存；
 *   · **成本有界**：K×每行截断长度，默认 ≈700 字符（被省掉的通常是数千到数十万字符）；
 *   · **与失败/字面量点名去重**：已经单独点名过的行不重复出现。
 * 开关：DSH_RECLAIM_SAMPLE_LINES=0 关闭。
 */
const SAMPLE_LINES = intEnv('DSH_RECLAIM_SAMPLE_LINES', 0)
/**  ⑥ 判定为"真表格"时默认抽多少行（0 = 表格也不抽）。 */
const TABLE_SAMPLE_LINES = intEnv('DSH_RECLAIM_TABLE_SAMPLE_LINES', 16)
/** 抽样行写进标记时的单行截断长度。 */
const SAMPLE_TEXT_MAX = intEnv('DSH_RECLAIM_SAMPLE_TEXT_MAX', 70)

/**
 *   ⑥ 表格检测（照抄 dsh-plugin-save-token 的 delimiterProfile / looksTabular）。
 *
 * 为什么要先判形状：**对表格抽样有意义**（每行是一条记录，抽出来就是"带坐标的地图"）；
 * **对散文抽样是有害的**（把句子切碎塞给模型，既看不懂又占 token）。
 * 实测教训：我第一版无脑等间隔抽 12 行，对着 3 条散文类事实 0/3 命中 —— 就是因为没先判形状。
 *
 * 判据（照抄）：主导轮廓必须是**真分隔符**（管道 p<n> / 制表符 t<n>，拒绝无分隔符的 x），
 * 且 **≥70% 行共享同一轮廓**、总数 **≥12 行**。
 * @param lines - 全部行。
 * @param from - 起始下标（含）。
 * @param to - 结束下标（不含）。
 * @returns boolean。
 */
function delimiterProfile (l) {
  const str = String(l)
  let pipes = 0
  let tabs = 0
  for (let i = 0; i < str.length; i += 1) {
    const ch = str.charAt(i)
    if (ch === '|') pipes += 1
    else if (ch === '\t') tabs += 1
  }
  /*  本项目扩展：PowerShell / docker / ls -l 这类输出常用**多个空格**对齐成列
     ⇒ 把"2 个以上空格的簇"也算一种分隔轮廓（save-token 原版只认管道与制表符，
     在 Windows 场景下会漏掉绝大多数表格）。 */
  const gaps = (str.match(/ {2,}/g) ?? []).length
  if (pipes > 0) return 'p' + pipes
  if (tabs > 0) return 't' + tabs
  if (gaps > 0) return 's' + gaps
  return 'x'
}

function looksTabular (lines, from, to) {
  const profiles = new Map()
  let dense = 0
  for (let i = from; i < to && i < lines.length; i += 1) {
    if (String(lines[i]).trim() === '') continue
    dense += 1
    const p = delimiterProfile(String(lines[i]))
    profiles.set(p, (profiles.get(p) ?? 0) + 1)
  }
  if (dense < 12) return false
  let best = 0
  let bestKey = 'x0'
  for (const [k, v] of profiles) if (v > best) { best = v; bestKey = k }
  return bestKey.charAt(0) !== 'x' && best >= dense * 0.7 && best >= 12
}

/**
 * 等间隔抽样（0-based 半开区间 from..to）。
 * @param lines - 全部行。
 * @param from - 起始下标（含）。
 * @param to - 结束下标（不含）。
 * @param k - 最多取几行。
 * @returns '{ line, text }' 数组（line 是 1 起的真实行号）。
 */
function sampleLines(lines, from, to, k) {
  const n = to - from
  if (n <= 0 || k <= 0) return []
  if (n <= k) return lines.slice(from, to).map((t, i) => ({ line: from + i + 1, text: t }))
  const step = n / k
  const out = []
  for (let i = 0; i < k; i += 1) {
    const idx = from + Math.floor(i * step)
    out.push({ line: idx + 1, text: lines[idx] })
  }
  return out
}

function bound(text, cap, pointer) {
  if (typeof text !== "string" || text.length === 0) return null
  if (cap === null || typeof cap !== "object") return null
  const lines = text.split("\n")
  const headLines = cap.headLines
  const tailLines = cap.tailLines
  /*  P1-2：判据同时看**行数与字符** —— 原先只看行数，于是"少行但单行超长"的结果
     （如一条 20000 字符的 JSON、一坨 base64）永远剪不到，而它们同样占 token。 */
  const enoughLines = lines.length > headLines + tailLines + 1
  const enoughChars = text.length > cap.headChars + cap.tailChars
  if (!enoughLines && !enoughChars) return null

  /*  P2-2：按行累加（takeHeadLines / takeTailLines），**永不切在半行中间**。
     原先是 join 之后 .slice(0, headChars) —— 会劈开一行、甚至劈开一个多字节字符。 */
  const headBlock = takeHeadLines(lines, headLines, cap.headChars)
  const tailBlock = takeTailLines(lines, tailLines, cap.tailChars)
  const headCount = headBlock === "" ? 0 : headBlock.split("\n").length
  const tailCount = tailBlock === "" ? 0 : tailBlock.split("\n").length
  const omittedLines = Math.max(0, lines.length - headCount - tailCount)
  const omittedChars = Math.max(0, text.length - headBlock.length - tailBlock.length)
  /*  无损化：把「省略了哪几行」写进标记，并让指针带上**精确的 offset/limit**。
     原先只说"可分段取回"，模型得自己猜起点 —— 那等于半有损。
     行号口径（1-based）：firstOmitted = **实际保留的头部行数** + 1
     （因为 takeHeadLines 受行数与字符双限，实际行数可能少于 headLines）。 */
  const firstOmitted = headCount + 1
  const region = { firstOmitted, omittedLines }
  /*：被省略区域里的失败行必须点名（Reasonix buriedTestLog 探针的形状）。
      面向模型的文本一律**英文 + 缩写**（要求"用最少 token 的语言"）：
     日志（console.error）继续用中文 —— 那是给人看的，不花模型 token。 */
  const highlights = failureHighlights(lines, headCount, lines.length - tailCount, FAILURE_HIGHLIGHT_LIMIT)
  const failNote = highlights.length === 0
    ? ""
    : " ERR(" + highlights.length + "): " + highlights.join("; ")
  /*  A-14：被省略区域里的键值/字面量也点名（研-03 学自 dsh-context-management 的 windowEvidenceIndex）。 */
  const literals = literalHighlights(lines, headCount, lines.length - tailCount, LITERAL_HIGHLIGHT_LIMIT)
  const literalNote = literals.length === 0
    ? ""
    : " LIT(" + literals.length + "): " + literals.join("; ")
  /*：抽样兜底 —— 覆盖"认不出形状"的事实（散文 / CSV 数字 / 普通词）。
     与上面两处点名去重：已经单独点过的行不再重复。 */
  const omittedFrom = headCount
  const omittedTo = Math.max(headCount, lines.length - tailCount)
  const namedTexts = new Set([...highlights, ...literals].map((s) => String(s).replace(/^L\d+\s*/, "").trim()))
  /*  ⑥ 只在**真表格**上开抽样（散文一律不抽）。表格默认抽 TABLE_SAMPLE_LINES 行。 */
  const tabular = looksTabular(lines, omittedFrom, omittedTo)
  const sampleK = tabular ? (SAMPLE_LINES > 0 ? SAMPLE_LINES : TABLE_SAMPLE_LINES) : SAMPLE_LINES
  const sampledAll = sampleK > 0 ? sampleLines(lines, omittedFrom, omittedTo, sampleK) : []
  const sampled = sampledAll.filter((s) => {
    const t = String(s.text ?? "").trim()
    return t !== "" && !namedTexts.has(t)
  })
  const sampleNote = sampled.length === 0
    ? ""
    : " SMP(" + sampled.length + "): "
      + sampled.map((s) => "L" + s.line + " " + String(s.text ?? "").trim().slice(0, SAMPLE_TEXT_MAX)).join("; ")
  const marker = "\n\n[cut L" + firstOmitted + "-" + (firstOmitted + omittedLines - 1)
    + " " + omittedLines + "L/" + omittedChars + "c." + failNote + literalNote + sampleNote + " "
    + pointerFor2(pointer, region) + "]\n\n"
  const out = headBlock + marker + tailBlock
  /* 兜底：万一 marker 比省掉的还多，就不动。 */
  if (out.length >= text.length) return null
  return out
}

/** 把区域信息补进指针（只有"能按行定位"的类型才有意义）。 */
function pointerFor2(pointer, region) {
  if (typeof pointer === "function") return pointer(region)
  return pointer
}

/**
 * 取回指针：告诉模型"完整内容怎么拿回来"（英文，token 最少）。
 * **这是"有界"能被接受的前提** —— 没有指针的有界 = 信息永久丢失（yaml 明确禁止）。
 *
 *  无损化：readOnly 分支返回**函数**，由 bound() 把精确区域喂进来，
 * 于是指针能写出确切的 offset 与 limit，模型无需猜。
 *  精简：全英文 + "full:" 前缀（实测同义表达比中文短 ~40%，且是"可复制执行"的形状）。
 */
function pointerFor(kind, toolName, text) {
  if (kind === "readOnly") {
    const path = pathOfEnvelope(text)
    if (path !== undefined) {
      return function (region) {
        return "full: read({file_path:" + JSON.stringify(path)
          + ",offset:" + region.firstOmitted + ",limit:" + region.omittedLines + "})"
      }
    }
    return function (region) {
      return "full: rerun cmd by lines (from L" + region.firstOmitted + ", " + region.omittedLines + " lines)"
    }
  }
  if (kind === "sideEffect") {
    /* 命令输出无法按行定位（重跑结果可能不同）⇒ 只能给"重跑 + 缩小范围"的指引。 */
    return "full: rerun cmd (narrow range: -First/-Tail or paging)"
  }
  return "full: re-fetch the content"
}

/* ══════════════ 三、纯函数入口 ══════════════ */

/** 无损噪声净化；未过门槛返回 null。 */
function applyNoise(text, opts, minChars, minRatio) {
  let out = text
  if (opts.noise !== false) {
    out = out.replace(ANSI, "")
    out = collapseCarriageReturns(out)
    out = out.replace(TRAILING_WS, "")
    out = out.replace(BLANK_RUN, "\n\n")
  }
  if (opts.stripLines === true) {
    out = out.replace(PROGRESS_LINE, "").replace(GIT_COUNT_LINE, "").replace(BLANK_RUN, "\n\n")
  }
  if (out === text) return null
  const saved = text.length - out.length
  if (saved < minChars || saved / text.length < minRatio) return null
  return out
}

/** 按类型有界；不需要或未过门槛返回 null。 */
function applyBound(text, opts, minRatio) {
  if (opts.bounded === false) return null
  const kind = opts.kind
  if (kind === undefined || kind === null || kind === "faithful") return null
  const cap = kind === "readOnly"
    ? (opts.capReadOnly ?? CAP_DEFAULTS.readOnly)
    : (opts.capSideEffect ?? CAP_DEFAULTS.sideEffect)
  const out = bound(text, cap, pointerFor(kind, opts.toolName, text))
  if (out === null) return null
  const saved = text.length - out.length
  /* 有界是有损的 ⇒ 门槛用 yaml 的 noOpGuardRatio（默认 5%），比噪声那道严得多。 */
  if (saved / text.length <= minRatio) return null
  return out
}

/**
 * 净化一段纯文本。**只做增量**：返回 null 表示没有必要改（不 emit）。
 * @param text - 纯文本。
 * @param opts - '{ stripLines, noise, bounded, kind, toolName, capReadOnly, capSideEffect, noOpGuardRatio }'。
 * @returns 净化后的文本，或 null（无变化/收益太小）。
 */
function purify(text, opts) {
  if (typeof text !== "string" || text.length === 0) return null
  const o = opts ?? {}
  const ratio = typeof o.noOpGuardRatio === "number" ? o.noOpGuardRatio : 0.05

  let out = text
  let changed = false

  /* ① 无损噪声：门槛低（0.2%），因为单条噪声本来就少。 */
  const noised = applyNoise(out, o, 32, 0.002)
  if (noised !== null) { out = noised; changed = true }

  /* ② 按类型有界：门槛高（5%），因为切行有信息损失。 */
  const bounded = applyBound(out, o, ratio)
  if (bounded !== null) { out = bounded; changed = true }

  return changed ? out : null
}

/** 只有全部是 text 块时才动；否则原样返回（与官方 spill 政策一致）。 */
function flattenPlainText(content) {
  if (!Array.isArray(content)) return undefined
  let text = ""
  let saw = false
  for (const block of content) {
    if (block === null || typeof block !== "object" || block.type !== "text") return undefined
    text += typeof block.text === "string" ? block.text : ""
    saw = true
  }
  return saw ? text : undefined
}

/** 从 exec 里取工具名（不同 DSH 版本字段名可能不同，都兜一层）。 */
function toolNameOf(exec, result) {
  return exec?.name ?? exec?.toolName ?? result?.name ?? result?.toolName ?? ""
}

/* ══════════════ ⑤ 近期源码保护（抄 dsh-compressor 的 PROTECT_RECENT_CODE） ══════════════
 * 为什么：模型刚 write/edit 过的文件，往往正是它下一步要接着改的
 *   ⇒ 对这种文件的 read 结果做骨架化（R3）会把"它正盯着的细节"压掉 = 降智。
 * 做法：在 llm/stream 里每帧扫出 write/edit 的路径喂进集合（LRU 上限 50），
 *   post-execute 里若 read 的正是这些路径 ⇒ 跳过骨架化（有界 R0 照常，因为它带精确指针）。
 * 零缓存代价：这只**少做一件事**（不动历史、不改已发出的内容）。
 * ═══════════════════════════════════════════════════════════════════════════════ */
const RECENT_EDITED_MAX = 50
const recentEditedPaths = new Map()

/* ══════════════ ④ 识别官方 spill 通知（抄 dsh-compressor 的 isOfficialSpillNotice） ══════════════
 * 官方在结果超过 ~50KB 时会把它落盘，并换成"首尾预览 + locator"。那**已经是官方的产物**
 * ⇒ 本插件再净化/有界就是"二次处理同一个东西"（改不动它，还可能把 locator 弄坏）。
 * 判据：文本较短且含"已落盘/完整内容见/read 取回"这类 locator 形状。
 * ═══════════════════════════════════════════════════════════════════════════ */
const SPILL_NOTICE_RE = /(已?落盘|spill(ed)?\s+to|full\s+content\s+(is\s+)?(saved|spilled)|完整内容(见|已保存|可用 read)|locator\s*:)/i

/**
 * 是否是官方 spill 通知（是 ⇒ 放手不处理）。
 * @param text - 工具结果的纯文本。
 * @returns boolean。
 */
function isOfficialSpillNotice (text) {
  const t = String(text ?? '')
  return t.length > 0 && t.length < 4000 && SPILL_NOTICE_RE.test(t)
}

/* ══════════════ 四、cordis 插件入口 ══════════════ */

export const name = "reclaim"
export const inject = ["tools", "llm"]   /*  P0-3：llm/stream 是唯一能拿到真实 payload 的钩子 */

/* ══════════════ 三之二、插件层接管「可写请求」（等价官方 dsh-llm 文件补丁） ══════════════ */

import z from '@deepseek-ai/schemastery'
import { pathToFileURL } from 'node:url'
import { basename, dirname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

/**
 * 为什么需要这一段
 * ---------------------------------------------------------------
 * 主线路的对话请求由 agent-loop 构造成**冻结对象**后交给 '@deepseek-ai/dsh-llm'。
 * 未打补丁时它的入口是（'dsh-llm/lib/index.js'）：
 *
 *     stream(options) { return this.streamWithRegistration(options) }
 *     streamWithRegistration(options, prepared) {
 *       return this.ctx.waterfall(this, 'llm/stream', options,
 *                                () => this.adapterStream(options, prepared))
 *     }
 *
 * 瀑布的 next 是**忽略参数**的闭包，adapter 用的仍然是外层 options
 *   ⇒ 本插件在 'llm/stream' 里 'next(新对象)' 无效；
 *   ⇒ 就地改写又撞上 Object.freeze；
 *   ⇒ 结果是主线路上所有净化/有界改写**静默失效**（只有审计日志看起来正常）。
 *
 * 官方做法是改 'dsh-llm/lib/index.js' 里那 6 行。这里改成**在插件层包一层**
 * 'ctx.llm.streamWithRegistration'，效果等价：冻结对象 ⇒ 浅拷贝（顶层 + messages
 * 数组 + 每个消息对象）⇒ 交给瀑布。拷贝件必须用 'markAgentLoopRequest' 标记，
 * 因为 '@deepseek-ai/dsh-session-title' 靠 'isAgentLoopRequest(options)' 判断
 * 「这是主线请求」才会自动改会话标题 —— 漏标等于悄悄丢掉自动标题。
 *
 * 健壮性：全部 fail-open，任何一步不成立都只是**退回只读**，绝不报错、绝不改坏别人：
 *   · 拿不到 ctx.llm / streamWithRegistration  ⇒ 跳过（其余功能照旧）；
 *   · 定位不到 markAgentLoopRequest             ⇒ 跳过（宁可降级也不悄悄丢自动标题）；
 *   · 宿主本来就打过补丁（对象不冻结）           ⇒ 原样透传，零行为变化；
 *   · 检测到 invariants 服务（agent-loop 的冻结断言已加载）⇒ 跳过，避免断言中断会话；
 *   · 环境变量 DSH_RECLAIM_WRITABLE_REQUEST=0   ⇒ 关闭本接管。
 */
const WRITABLE_REQUEST_ON = process.env.DSH_RECLAIM_WRITABLE_REQUEST !== '0'

/** 一次性启动日志；受 DSH_RECLAIM_LOG 统管，不额外刷屏。 */
function writableLog (message) {
  if (process.env.DSH_RECLAIM_LOG === '0') return
  console.error('[reclaim/writable] ' + message)
}

/** 官方补丁体检的日志前缀；同样受 DSH_RECLAIM_LOG 统管。 */
function patchLog (message) {
  if (process.env.DSH_RECLAIM_LOG === '0') return
  console.error('[reclaim/patch-check] ' + message)
}

/** 从命令行推导 DSH 包根（'…/@deepseek-ai/dsh'）。桌面外壳把真正的 bin.js 放在 argv[2]
 *  （argv[1] 是 harness-node-entry.mjs），所以整条 argv 都要扫，不能只看 argv[1]。 */
function dshPackageRoots () {
  const roots = []
  for (const arg of process.argv) {
    if (typeof arg !== 'string') continue
    if (!/@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$/i.test(arg)) continue
    const root = dirname(dirname(arg))   /* …/@deepseek-ai/dsh/lib/bin.js ⇒ …/@deepseek-ai/dsh */
    if (root !== '' && !roots.includes(root)) roots.push(root)
  }
  return roots
}

/** 从 dsh 入口文件推导 '@deepseek-ai/dsh-llm' 的候选文件（不依赖 node 的包解析）。 */
function dshLlmCandidates () {
  const out = []
  const push = (file) => {
    if (typeof file === 'string' && file !== '' && !out.includes(file)) out.push(file)
  }
  for (const dshPkg of dshPackageRoots()) {
    push(join(dshPkg, 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js'))   /* npm 布局：依赖挂在 dsh 包内 */
    push(join(dshPkg, '..', 'dsh-llm', 'lib', 'index.js'))                             /* 平级布局：桌面端 app\node_modules */
    /* 同一个文件往往有多种拼法（真目录 / junction / 包解析结果），而 **Node 的 ESM 加载器
       对直接 file:// URL 不做软链接归一化** —— 不同拼法会各自造出一份模块实例，各自的
       WeakSet 互不相认。宿主用的是哪一份无法预知，所以把所有拼法都塞进候选，
       最后统一交给往返自检去挑（见 pickWritableModule）。 */
    try {
      const resolved = createRequire(join(dshPkg, 'lib', 'bin.js')).resolve('@deepseek-ai/dsh-llm')
      push(resolved)                                                                    /* 由宿主入口解析出来的那一份 */
    } catch { /* 解析不了就少一个候选，不影响其余路径。 */ }
  }
  /* profile 侧：DSH 把插件装进 '$DSH_HOME/profiles/<profile>/node_modules'，并从
     '$DSH_HOME/profiles/node_modules' 走软链接加载。宿主很可能正是从这两条 junction 路径
     加载的，所以把它们的拼法也当候选。 */
  const dshHome = process.env.DSH_HOME
  const profileRoot = typeof dshHome === 'string' && dshHome !== '' ? join(dshHome, 'profiles') : null
  if (profileRoot !== null) {
    push(join(profileRoot, 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js'))
    try {
      for (const entry of readdirSync(profileRoot, { withFileTypes: true })) {
        if (entry.isDirectory() !== true) continue
        push(join(profileRoot, entry.name, 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js'))
      }
    } catch { /* 读不到 profiles 目录就跳过，不影响其余候选。 */ }
  }
  return out
}

/* ── 官方补丁体检：只读，不自动动手 ────────────────────────────────────────
 * DSH 官方 1.5 一共带 9 条文件补丁。其中只有 '@deepseek-ai/dsh-llm' 那条是本插件的
 * 历史依赖，现已由上面的「接管可写请求」取代；其余几条改的是 DSH 自身的机器行为，
 * 插件替代不了，属于可选增强。这里只在启动时**报告**，绝不替使用者改官方文件 ——
 * 打补丁是会动到 DSH 安装目录的操作，决定权必须在使用者手上。
 * 判据是「打过补丁的文件旁边会留下 '*.<文件名>.orig*' 备份」（官方补丁脚本的约定），
 * 所以它是**启发式**：备份被手工删掉会误报「未检测到」，补丁回滚但备份没清会误报「已打过」。
 * 措辞一律保守（「未检测到」），不假装精确。
 */
const OFFICIAL_PATCH_TARGETS = [
  { id: 'dsh-llm-writable-request', pkg: 'dsh-llm', file: ['lib', 'index.js'], label: 'dsh-llm 可写请求' },
  { id: 'agent-loop-snapshot-prompt', pkg: 'dsh-agent-loop', file: ['lib', 'index.js'], label: 'agent-loop 快照回收 / 系统提示收敛' },
  { id: 'llm-pi-ai-system-prompt', pkg: 'dsh-llm-pi-ai', file: ['lib', 'index.js'], label: 'pi-ai 系统提示收集' },
  { id: 'compaction-pruner', pkg: 'dsh-compaction-tool-result-pruner', file: ['lib', 'index.js'], label: '压缩期工具结果剪枝' },
  { id: 'ui-renderer-turntail', pkg: 'dsh-client-ui-renderer', file: ['lib', 'client.js'], label: '交付行 / knowledge 行排序' },
  { id: 'ui-sidebar-wrap', pkg: 'dsh-client-ui-sidebar', file: ['lib', 'lib-client.js'], label: '侧栏页脚槽位换行（纯样式）' },
  { id: 'session-format-v1-to-v2', pkg: 'dsh-session-format-v1-to-v2', file: ['lib', 'index.js'], label: '会话 turn/start 修复' },
  { id: 'session-persistence-jsonl', pkg: 'dsh-session-persistence-jsonl', file: ['lib', 'worker.cjs'], label: '会话持久化修复' },
  { id: 'mcp-client', pkg: 'dsh-mcp-client', file: ['lib', 'index.js'], label: 'MCP 工具增量同步（不整批注销）' },
  { id: 'pi-ai-max-tokens-floor', pkg: 'pi-ai', scope: '@earendil-works', file: ['dist', 'api', 'simple-options.js'], label: 'pi-ai max_tokens 下界' }
]

/** 目标包的候选目录：桌面端与 dsh 平级，npm 布局则嵌在 dsh 包内。 */
/**
 * 目标包的候选目录。@param pkg - 包名（不含作用域）。
 * @param scope - 作用域目录名，默认 @deepseek-ai；第三方包（如 @earendil-works/pi-ai）要显式传。
 *   桌面端：<X>/<scope>/<pkg>（dshPkg 是 <X>/@deepseek-ai/dsh，往上两级到 <X>）。
 *   npm 布局：<dsh 包>/node_modules/<scope>/<pkg>。
 */
function patchPackageDirs (pkg, scope = '@deepseek-ai') {
  const dirs = []
  for (const dshPkg of dshPackageRoots()) {
    dirs.push(join(dshPkg, '..', '..', scope, pkg))
    dirs.push(join(dshPkg, 'node_modules', scope, pkg))
  }
  return dirs
}

/** 该文件旁边是否留有 '<文件名>.orig*' 备份 ⇒ 打过补丁的迹象。读不到目录就当没打。 */
function hasPatchBackup (target) {
  const base = basename(target)
  try {
    return readdirSync(dirname(target)).some((name) => name.startsWith(base + '.orig'))
  } catch { return false }
}

/** 启动时打一行体检结论；不写文件、不改行为、任何异常都静默。 */
function reportOfficialPatches () {
  if (process.env.DSH_RECLAIM_PATCH_CHECK === '0') return
  try {
    const missing = []
    let seen = 0
    for (const item of OFFICIAL_PATCH_TARGETS) {
      for (const dir of patchPackageDirs(item.pkg, item.scope)) {
        const target = join(dir, ...item.file)
        if (existsSync(target) !== true) continue
        seen += 1
        if (hasPatchBackup(target) !== true) missing.push(item.label)
        break
      }
    }
    if (seen === 0) return                        /* 推导不出安装布局 ⇒ 不猜，保持安静 */
    if (missing.length === 0) {
      patchLog('官方补丁体检：' + seen + ' 个官方补丁目标都已检测到补丁痕迹（按 *.orig 备份判断）。')
      return
    }
    patchLog('官方补丁体检（只读，本插件不会自动改官方文件）：' + seen + ' 个目标里未检测到 ' + missing.length +
      ' 条 —— ' + missing.join('、') + '。其中「dsh-llm 可写请求」已由本插件自行接管，不需要打；' +
      '其余是可选增强，插件替代不了（改的是 DSH 自身的机器行为）。要打的话，补丁库 ' +
      'https://github.com/xiamubumu/dsh-patch-library 里有现成提示词与五种打法，整段交给你的 agent 执行即可。')
  } catch { /* 体检失败绝不影响启动。 */ }
}

/** 收集所有能拿到 'markAgentLoopRequest' 的 dsh-llm 副本；一份都没有时返回空数组并说明原因。 */
async function resolveWritableModules () {
  const tried = []
  const mods = []
  const add = (label, mod) => {
    if (typeof mod?.markAgentLoopRequest !== 'function') { tried.push(label + '：模块里没有 markAgentLoopRequest'); return }
    if (mods.some((m) => m.mark === mod.markAgentLoopRequest)) return
    mods.push({
      label,
      mark: mod.markAgentLoopRequest,
      isAgent: typeof mod.isAgentLoopRequest === 'function' ? mod.isAgentLoopRequest : null
    })
  }
  /* ① 先用「正在运行的那个 dsh-llm」。按包名 import 在 link: 安装 + 开发机 junction
        下可能解析到**另一份**副本，所以还必须在调用点做往返自检（见 pickWritableModule）。 */
  for (const file of dshLlmCandidates()) {
    try { add('文件 ' + file, await import(pathToFileURL(file).href)) } catch (err) { tried.push('文件 import 失败：' + file + ' → ' + String(err?.message ?? err)) }
  }
  /* ② 再退回按包名 import（argv 里找不到 bin.js 时，例如被 Electron 主进程内嵌）。 */
  try { add('包名 import', await import('@deepseek-ai/dsh-llm')) } catch (err) { tried.push('包名 import 失败：' + String(err?.message ?? err)) }
  if (mods.length === 0) writableLog('定位不到 markAgentLoopRequest ⇒ 不在插件层接管（主线路改写退回只读，功能降级但不报错）。尝试过：' + tried.join(' ｜ '))
  return mods
}

/**
 * 选一份「和宿主同一个模块实例」的副本。
 * 判据是**往返自检**：宿主请求是它用自己那份模块标记过的，只有共享同一个 WeakSet 的
 * 那一份才会让 'isAgentLoopRequest(options)' 返回 true。副本不一致时标记会落进别人家的
 * WeakSet ⇒ 改写照常、但 '@deepseek-ai/dsh-session-title' 的自动标题会静静失效。
 * 一份都测不出来时退回第一份并**明确打一次警告**（宁可功能在，也要让日志说实话）。
 */
function pickWritableModule (mods, options) {
  for (const mod of mods) {
    if (mod.isAgent !== null && mod.isAgent(options) === true) return mod
  }
  if (mods.length === 0) return null
  if (pickWritableModule.warned !== true) {
    pickWritableModule.warned = true
    writableLog('找不到「和宿主同一实例」的 dsh-llm 副本 ⇒ 仍会接管可写请求，但标记可能不被 @deepseek-ai/dsh-session-title 识别（自动标题可能不更新）。已加载副本：' + mods.map((m) => m.label).join(' ｜ '))
  }
  return mods[0]
}

/** 冻结请求 ⇒ 可写请求：顶层 + messages 数组 + 每个消息对象，再打上 agent-loop 标记。 */
function writableCopy (options, mark) {
  const messages = Array.isArray(options.messages)
    ? options.messages.map((m) => (m !== null && typeof m === 'object' ? { ...m } : m))
    : options.messages
  return mark({ ...options, messages })
}

/** 包一层 ctx.llm.streamWithRegistration；只包装一次，重复 apply 不会叠加。 */
function installWritableRequest (ctx) {
  if (!WRITABLE_REQUEST_ON) { writableLog('DSH_RECLAIM_WRITABLE_REQUEST=0 ⇒ 不接管'); return }
  const llm = ctx?.llm
  if (llm === null || llm === undefined || typeof llm !== 'object' || typeof llm.streamWithRegistration !== 'function') {
    writableLog('拿不到 ctx.llm.streamWithRegistration ⇒ 不接管（主线路改写退回只读，其余功能不受影响）')
    return
  }
  if (llm.streamWithRegistration.__reclaimWrapped === true) { writableLog('已经接管过 ⇒ 跳过（防重复包装）'); return }
  try {
    if (ctx.get('invariants') !== undefined) {
      writableLog('检测到 invariants 服务（@deepseek-ai/dsh-agent-loop-invariant 已加载）⇒ 不接管，避免「a loop-built request must be frozen」断言中断会话')
      return
    }
  } catch { /* 探测失败按「没有」处理，继续。 */ }
  void (async () => {
    try {
      const mods = await resolveWritableModules()
      if (mods.length === 0) return
      const current = llm.streamWithRegistration
      if (typeof current !== 'function' || current.__reclaimWrapped === true) return
      const wrapped = function (options, prepared) {
        try {
          if (options !== null && typeof options === 'object' && Object.isFrozen(options) === true) {
            const mod = pickWritableModule(mods, options)
            if (mod !== null) return current.call(this, writableCopy(options, mod.mark), prepared)
          }
        } catch (err) {
          writableLog('拷贝失败 ⇒ 按原样发送：' + String(err?.message ?? err))
        }
        return current.call(this, options, prepared)
      }
      wrapped.__reclaimWrapped = true
      llm.streamWithRegistration = wrapped
      writableLog('已接管 llm.streamWithRegistration：冻结的主请求先浅拷贝再进 llm/stream ⇒ 不再需要给官方 dsh-llm 打文件补丁（可用 dsh-llm 副本 ' + mods.length + ' 份）')
    } catch (err) {
      writableLog('接管失败 ⇒ 完全退回官方原样：' + String(err?.message ?? err))
    }
  })()
}

/**
 * @param ctx - 插件上下文（需 'tools' 服务以拿到 'tools/post-execute' 瀑布）。
 * @param config - 见文件头的安全阀说明。
 */
/**
 * 宿主从这个导出里推导 settings namespace（dsh-context-reclaim），再用该 key 渲染
 * `settings.plugin.item` 卡片。没有它，设置页里就永远看不到本插件的开关 ——
 * 这正是"设置里没有按钮"的根因。
 */
export const Config = z.object({
  showPatchNotice: z.boolean().default(true)
    .description('打开时弹窗提示本插件需要的官方补丁；关掉即不再提示（等价于弹窗里的「不再提醒」）')
})

export function apply(ctx, config = {}) {
  const cfg = config ?? {}
  const enabled = cfg.enabled !== false
  if (!enabled) return
  const noise = cfg.noise !== false && process.env.DSH_RECLAIM_NOISE !== "0"
  const bounded = cfg.bounded !== false && process.env.DSH_RECLAIM_BOUNDED !== "0"
  const stripLines = cfg.stripLines === true || process.env.DSH_RECLAIM_STRIP_LINES === "1"
  const noOpGuardRatio = typeof cfg.noOpGuardRatio === "number" ? cfg.noOpGuardRatio : 0.05
  /**
   * 超过这个字节数就**完全放手**（不再有界）。
   *
   *   更新：这个值必须与「谁在管大结果」保持一致。
   *
   * 曾经短暂设成 8192，意图是对齐官方 '@deepseek-ai/dsh-spill-policy' 的
   * 'maxInlineBytes'（让它接盘 >8KB 的结果 —— 它会给 locator + 取回指引，
   * 比本插件截断无损）。但**实测发现 spill 那套在当前机器根本不可用**
   *   · '@deepseek-ai/dsh-spill-local' / '-policy' / 'dsh-spill' 都**不在
   *     <DSH_HOME>\AppData\Roaming\dsh-desktop\harness\profiles\web\node_modules'
   *     里**（profile 只链接 'package.json' 的 'dsh.profile.bundles' 声明过的包，
   *     这三个没被声明）；
   *   · 往 'cordis.patch.yml' 里 insert 它们会**直接让 Harness 起不来**
   *     'TypeError: duplicate loader entry id: spill-local'
   *     + 启动日志 'the patch layer inserts @deepseek-ai/dsh-spill-local, which is
   *     not installed'。
   *   ⇒ 那两行 insert 已撤销，**当前机器不依赖 spill**。
   *
   * 既然没有下游接盘，"放手阈值"就必须留在**足够大**的位置 —— 否则
   * 放手区间（阈值 ~ 无穷）里的结果既没指针也没落盘 = 纯粹的有损。
   * 50000 是经过验证的原值（read 单条实测最大 60,038 字节 ⇒ >50KB 极罕见）。
   *
   * 若将来真的把 spill 装进 profile 并启用，**这个值要同步改成 8192**
   * （两边对齐才不留缝），并同时改 'profiles\web\cordis.patch.yml'。
   */
  const maxInlineBytes = typeof cfg.maxInlineBytes === "number" ? cfg.maxInlineBytes : 50000

  /* 插件层接管「可写请求」（等价官方 dsh-llm 文件补丁）：启动即尝试，
     任何一步不成立都只是退回只读，不抛错、不影响下面所有其它功能。 */
  installWritableRequest(ctx)
  reportOfficialPatches()
  /* 官方补丁提醒：本插件受益的那两条（agent-loop 快照回收/系统提示收敛、
     以及只有跟它一起才有意义的 pi-ai splitSystemPrompt）插件层做不了。
     这里只挂路由、只报告，由自带客户端半边弹一次窗；绝不改官方文件，
     也绝不读别的插件的任何东西。 */
  installPatchNotice(ctx)

  ctx.on("tools/post-execute", async (exec, result, next) => {
    const decision = await next()
    /*  R28：错误假设污染检测 —— 只记账 + 打警告，不改任何内容。
       放在最前面，因为失败结果会在下一行被豁免返回（早于它就没机会记账了）。 */
    try { noteToolFailure(exec, result) } catch { /* fail-open */ }
    try {
      if (decision.kind !== "accept") return decision
      // 已被别人替换过值 ⇒ 不抢（官方 spill 的同款护栏）
      if (Object.hasOwn(decision, "value")) return decision
      // 失败结果一律豁免（A7）
      if (result !== null && typeof result === "object" && result.isError === true) return decision
      const content = decision.content ?? result?.content
      const text = flattenPlainText(content)
      if (text === undefined) return decision
      /* 超大结果直接放手 ⇒ 让官方 spill-policy 去落盘（那边还有 locator 与取回指引）。 */
      if (typeof text === "string" && Buffer.byteLength(text, "utf8") > maxInlineBytes) return decision
      /*  ④ 已经是官方 spill 通知 ⇒ 再处理就是二次处理（还可能弄坏 locator）⇒ 放手。 */
      if (isOfficialSpillNotice(text)) return decision

      const toolName = toolNameOf(exec, result)
      const kind = kindOf(toolName, cfg)
      const purified = purify(text, {
        stripLines, noise, bounded, kind, toolName, noOpGuardRatio,
        capReadOnly: cfg.readOnly,
        capSideEffect: cfg.sideEffect,
      })
      if (purified === null) return decision
      /* R3 + R4（ 集中化）：AST 骨架化（read 类）+ 日志浓缩（pwsh 类）。
         零降智：焦点/非代码文件不动 · 失败行与栈行必留 · 只有确实变小才替换 · 原文件在磁盘可重读。 */
      let finalText = purified
      try {
        const argPath = (() => {
          try {
            const a = typeof exec?.arguments === "string" ? JSON.parse(exec.arguments) : (exec?.arguments ?? {})
            return String(a?.file_path ?? a?.path ?? a?.filePath ?? "")
          } catch { return "" }
        })()
        if (argPath.length > 0) {
          /*  ⑤ 近期源码保护：刚被 write/edit 改过的文件不骨架化（模型正在盯它，别把细节压掉）。 */
          const ast = skeletonizeCode(finalText, argPath)
          if (ast !== null) finalText = ast
        }
        const log = compressLog(finalText)
        if (log !== null) finalText = log
      } catch { /* fail-open：R3/R4 出问题就用原净化结果 */ }
      if (finalText !== purified) {
        try { console.error("[reclaim/ast-log] " + toolNameOf(exec, result) + "：" + purified.length + " -> " + finalText.length + " 字符") } catch { /* ignore */ }
      }
      return {
        kind: "accept",
        content: [{ type: "text", text: finalText }],
        ...(decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {}),
      }
    } catch {
      /* fail-open：任何意外都返回原决策，绝不把成功调用变成失败。 */
      return decision
    }
  }, { prepend: true })

  /*   P0-3｜缓存归因：llm/stream 是唯一能拿到"真实 payload"的钩子
     （dsh-llm/lib/index.js L2307）。只读：不改 options、不改 chunk、任何异常 fail-open。
     关掉：config.attribution === false。 */
  /*  R20：预算观测 —— **只记录，永不拦截**（'return next()' 不变）。
     生态里的 'dsh-turn-budget' 是 fail-closed 硬拦（默认 40 次工具/轮），
     实测一个任务要 93 次 ⇒ 硬拦会伤质量 ⇒ 这里只观测。 */
  ctx.on("tools/pre-execute", (toolCall, next) => {
    try {
      const nm = toolCall?.name ?? toolCall?.toolName ?? toolCall?.tool?.name
      const a = toolCall?.arguments ?? toolCall?.args ?? toolCall?.input
      /*  R22：完全相同的重复编辑 ⇒ 拦截（无损：结果必然一样）。 */
      const dup = checkDuplicateEdit(nm, a)
      if (dup !== null) return dup
      noteToolCall(nm, a)
    } catch { /* fail-open：观测/去重失败绝不影响执行 */ }
    return next()
  })

  /**
   *  R27：**压缩摘要质量审计** —— 只警告，一个字节都不改。
   *
   * 依据 'context-optimization'：「Target 50-70% token reduction with less than 5%
   * quality degradation」+「If compaction exceeds 70% reduction, audit the summary
   * for critical information loss」。
   *
   * 官方 '@deepseek-ai/dsh-compaction-basic' 的 COMPACTION_INSTRUCTION 明确要求摘要
   * **必须**含这 8 段且**保序**（'keep every section, in order'）：
   *   ## Primary Request and Intent / ## Key Technical Concepts / ## Files and Code /
   *   ## Errors and Fixes / ## Pending Jobs / ## Current Work / ## Next Step /
   *   ## Critical Context
   * 出处：'<APP_ROOT>\node_modules\@deepseek-ai\dsh-compaction-basic\lib\index.js:220-246'
   *
   * 但它**只要求、不校验** —— 模型漏段时没有任何反馈，压缩后关键信息就静默丢了。
   * 本插件监听 'session/event' 里的 'compaction/summary'（该事件由
   * 'commitCompactionBody' 在 index.js:605 追加，字段含 'summary' /
   * 'shadowedTokenCount' / 'shadowedRange'），对照 8 段点名。
   *
   *  **绝不修改摘要**：摘要一旦写进历史就是前缀的一部分，改它 = 打断缓存 +
   * 违反「不改历史」纪律。这里只打一行 console.error（给人看，不花模型 token）。
   *
   * 关掉：'DSH_RECLAIM_AUDIT_SUMMARY=0'。
   */
  const SUMMARY_SECTIONS = [
    'Primary Request and Intent', 'Key Technical Concepts', 'Files and Code',
    'Errors and Fixes', 'Pending Jobs', 'Current Work', 'Next Step', 'Critical Context',
  ]
  ctx.on('session/event', (session, event) => {
    try {
      if (process.env.DSH_RECLAIM_AUDIT_SUMMARY === '0') return
      if (event?.type !== 'compaction/summary') return
      const summary = String(event?.data?.summary ?? '')
      if (summary === '') { console.error('[reclaim/summary-audit] 摘要为空（异常）'); return }
      const missing = SUMMARY_SECTIONS.filter((s) => !summary.includes('## ' + s))
      const shadowed = event?.data?.shadowedTokenCount
      const ratioNote = typeof shadowed === 'number' ? ' 压缩掉 ' + shadowed + ' tok' : ''
      if (missing.length > 0) {
        console.error('[reclaim/summary-audit] ⚠️ 摘要缺 ' + missing.length + '/8 段'
          + ratioNote + '：' + missing.join(' · ')
          + '  ⇒ 按 context-optimization 的建议，这里该人工核对是否有信息损失（本插件不代改）')
      } else {
        console.error('[reclaim/summary-audit] ✅ 摘要在 8 段结构上完整' + ratioNote)
      }
    } catch { /* fail-open：审计失败绝不能影响会话 */ }
  })

  ctx.on("llm/stream", (options, next) => {
    if (cfg.attribution === false) return next()
    const routeKey = routeKeyOf(options)
    /*  诊断：把每帧的 system prompt 落盘，用于 diff「到底哪一段在变」。
       打开：DSH_RECLAIM_DUMP_SYSTEM=1（默认关 ⇒ 零开销）。
       输出：<TEMP>\dsh-sysdump\sys-<seq>-<route>.txt（逐帧快照，diff 用）。 */
    if (process.env.DSH_RECLAIM_DUMP_SYSTEM === '1') {
      try {
        /* 本文件不含 import/require（宿主以极简形式注入）⇒ 用 getBuiltinModule 取 fs/path。 */
        const fsMod = process.getBuiltinModule?.('node:fs')
        const pathMod = process.getBuiltinModule?.('node:path')
        const msgs = Array.isArray(options?.messages) ? options.messages : []
        let text = ''
        for (const m of msgs) {
          if (m?.role !== 'system') break
          const arr = Array.isArray(m.content) ? m.content : []
          for (const b of arr) text += String(b?.text ?? '')
        }
        const dir = pathMod.join(process.env.TEMP || '.', 'dsh-sysdump')
        fsMod.mkdirSync(dir, { recursive: true })
        const seq = String(++systemDumpSeq).padStart(3, '0')
        fsMod.writeFileSync(pathMod.join(dir, 'sys-' + seq + '-' + routeKey.replace(/[^\w.-]/g, '_') + '.txt'), text, 'utf8')
      } catch { /* fail-open */ }
    }
    /*  R25：抹平 messages 里"每帧必变"的注入片段（时间戳 / 耗时）。
       真机证据：Current runtime context 出现 768 次、长度 100+ 种（含时间戳）⇒
       它每帧一变就在消息中间破前缀。归一化后内容固定 ⇒ 前缀稳定。
        只动 ISO 时间戳与 uptime/耗时，正文一字节不动；fail-open。
       注意：必须在**冻结检查之前**就地改（waterfall 的 next 用闭包引用原 options）。 */
    try {
      if (options !== null && typeof options === 'object' && Object.isFrozen(options) !== true && Array.isArray(options.messages)) {
        const frozenMsgs = freezeMessageVolatility(options.messages)
        if (frozenMsgs !== options.messages) {
          options.messages = frozenMsgs
          if (!volatileFreezeLogged) {
            volatileFreezeLogged = true
            console.error('[reclaim/ts-freeze] 已抹平 messages 里的时间戳/耗时（防每帧破前缀）')
          }
        }
      }
    } catch { /* fail-open */ }
    /*  R26：剥掉**历史** assistant 消息里的 reasoning 块（保留最近 N 轮）。
       真机证据：reasoning 占 assistant/message 的 53.7%、而助手消息占 prompt ~75%
       ⇒ 历史 reasoning 约等于整个 prompt 的 36%。Reasonix 是"能不带就不带"，
       官方 dsh-llm-deepseek 是无条件带 ⇒ 这里补上。
        这是**每帧都一样的确定性变换** ⇒ 剥离后的文本恒定 ⇒ 不破前缀。
       必须就地改（waterfall 的 next 用闭包引用原 options）；fail-open。 */
    try {
      if (options !== null && typeof options === 'object' && Object.isFrozen(options) !== true && Array.isArray(options.messages)) {
        const trimmed = stripHistoryReasoning(options.messages)
        if (trimmed !== options.messages) {
          /*  顺序要紧：必须先算差值再覆盖 —— 反过来的话左右两边都成了 stripped，差恒为 0。 */
          const beforeChars = countReasoningChars(options.messages)
          const afterChars = countReasoningChars(trimmed)
          const savedNow = Math.max(0, beforeChars - afterChars)
          options.messages = trimmed
          if (savedNow !== lastReasoningSaved) {
            lastReasoningSaved = savedNow
            const rk = process.env.DSH_RECLAIM_KEEP_REASONING_TURNS
            const keepShown = rk === undefined ? KEEP_REASONING_TURNS_DEFAULT : rk
            console.error('[reclaim/reasoning-strip] 剥掉历史 reasoning：省 ' + savedNow
              + ' 字符 /≈' + Math.round(savedNow / 3.9) + ' tok（剥前 ' + Math.round(beforeChars / 3.9)
              + ' tok ⇒ 剥后 ' + Math.round(afterChars / 3.9) + ' tok）· 保留最近 ' + keepShown
              + ' 轮 · 关闭：DSH_RECLAIM_STRIP_REASONING=0')
          }
        }
      }
    } catch { /* fail-open */ }
    /*  R28：把插件目录段从 system 前部搬到 messages 尾部。
       配对依据是"目录原文精确匹配"⇒ 对不上什么都不做（fail-safe）。
       搬完 system 恒定 ⇒ 那一大段（今天实测一次 -29 行 / +104 行）再怎么变
       都只影响尾部一条消息，前缀不再全废。 */
    try {
      if (options !== null && typeof options === 'object' && Object.isFrozen(options) !== true && Array.isArray(options.messages)) {
        const relocated = relocateCatalogToTail(options.messages)
        if (relocated !== options.messages) options.messages = relocated
      }
    } catch { /* fail-open */ }
    wireCallSeq += 1
    /*  入口探针（只打一次）：真机上"钩子被调用了、但改写块没进"时必须能一眼看出为什么
       （实测 ：payload/groups 日志都在、wire-trim 一行都没有 ⇒ 只能是这层判断没过）。 */
    if (!wireProbeLogged) {
      wireProbeLogged = true
      try {
        console.error('[reclaim/wire] 入口探测：messages='
          + (Array.isArray(options?.messages) ? options.messages.length + ' 条' : '非数组（' + typeof options?.messages + '）')
          + ' · options 冻结=' + Object.isFrozen(options)
          + ' · messages 冻结=' + Object.isFrozen(options?.messages)
          + ' · route=' + routeKey)
      } catch { /* ignore */ }
    }
    try {
      let wireVersion = 'v' + WIRE_REWRITE_VERSION
      let cacheBreak = false
      /*  tools 守卫：provider 会因"某个工具缺 name"**拒收整个请求**
         （实测报错形状：tools[1].function: missing field name）。
         折叠产物有守卫了，这里再兜一层：**最终要发的** tools 数组里只要有一项缺名，就留证据行。 */
      try {
        const arr = Array.isArray(options?.tools) ? options.tools : []
        const bad = []
        for (let i = 0; i < arr.length; i += 1) {
          const fn = arr[i] === null || typeof arr[i] !== 'object' ? undefined : arr[i].function
          const nm = fn === undefined ? arr[i]?.name : fn.name
          if (typeof nm !== 'string' || nm.length === 0) bad.push(i)
        }
        if (bad.length > 0) {
          console.error('[reclaim/tool-guard] ⚠️ 即将发出的 tools 里有 ' + bad.length + ' 项缺 name（下标 '
            + bad.join(',') + '）——provider 会拒收整个请求；这一帧的形状：'
            + arr.slice(0, 3).map((x, i) => i + ':' + Object.keys(x ?? {}).join('+')).join(' | '))
        }
      } catch { /* ignore */ }
      const shape = shapeOf(options)
      shape.routeKey = routeKey
      shape.wireVersion = wireVersion
      shape.logRewriteVersion = WIRE_REWRITE_VERSION
      shape.cacheBreak = cacheBreak
      shape.messageCount = Array.isArray(options?.messages) ? options.messages.length : 0
      /* R10/R9：分组归因 + 工具定义代价（先算，随收据一起落账）。 */
      maybeReportBudget(routeKey)
      const payload = notePayloadShape(options)
      shape.toolSchemaTokens = payload?.toolsTokens ?? 0
      recordCacheReceipt(shape, compareShape(shape), payload)
      return passthrough(next(), routeKey, purposeOf(options))
    } catch {
      return next()
    }
  })

  /*  R1（默认开）+ S1（R2 段收纳**默认关**）。
     依据：dsh-tool-folder 实测「assembly.tools 是请求 tools 的唯一来源，且执行不受它限制」⇒ 折叠不损失能力。
     零降智保障：折叠的工具留"名字+一句契约"；段收纳只丢"归属插件不在当前组合里"的段，表里没有的一律保留。
      S1 结论：**段收窄的职责归 dsh-capability-composer 的 prunePluginSections**
     （它有插件组合可见性、有逐条注明出处的归属表），reclaim 的 R2 只作"composer 不在"时的兜底 ⇒
     默认关（config.trimSections = true 或 DSH_RECLAIM_SECTION_TRIM=1 才开），两者**绝不重复丢同一段**。
     开关：DSH_RECLAIM_TOOL_FOLD=0 关 R1。 */
  const trimSections = cfg.trimSections === true || process.env.DSH_RECLAIM_SECTION_TRIM === '1'
  const foldTools = cfg.foldTools !== false
  ctx.on("system-prompt/assemble", async (assembly, context, next) => {
    const out = await next()
    if (!foldTools && !trimSections && !PROMPT_LINE_ON) return out
    try {
      const messages = Array.isArray(context?.messages) ? context.messages : []
      const intent = currentIntent(messages)
      const activePlugins = Array.isArray(config.activePlugins) ? config.activePlugins : []
      let res = out
      if (foldTools) res = foldToolSurface(res, intent)
      /*  R24：把易变段后置（稳定段在前）⇒ 段的"出现/消失"不再影响前面的前缀。 */
      res = orderSectionsStable(res)
      /*  R23：抹平"易变数字"（目录段的 N 个工具）⇒ 系统提示每帧一致 ⇒ 不破前缀。 */
      res = stabilizePromptCounts(res)
      /*  R15：独立于 R1/R2 生效（它只截"描述型长行"，不动指令行）。 */
      res = trimPromptLongLines(res)
      /*  R17：注入去重（删掉"内容已在对话历史里"的注入行；跨会话记忆保留）。 */
      res = dedupeInjectedContexts(res, messages)
      /*  R18：输出纪律（**追加在末尾** ⇒ 不动已有前缀 ⇒ 不破缓存）。 */
      res = appendOutputDiscipline(res)
      /*  R21：改动集中度软提醒（只在触发态注入，不拦）。 */
      res = appendBudgetNudge(res)
      if (trimSections) res = trimPromptSections(res, activePlugins)
      /*  R28：记下插件目录段原文（供流期"搬到消息尾部"用）。放在最后，
         因为前面的段重排/裁剪可能改变 sections。 */
      captureCatalogSection(res)
      return res
    } catch (error) {
      /* fail-open：任何意外都返回原始 assembly，绝不因本插件让请求失败。 */
      try { console.error('[reclaim/assemble] fail-open: ' + (error?.message ?? error)) } catch { /* ignore */ }
      return out
    }
  })

}

/* ══════════════════════════════════════════════════════════════════════════
 * P0-3｜缓存归因（PrefixShape + CacheBreak 收据）——
 *
 * ═══ 为什么需要 ═══
 *   官方本体 243 包 / 931 个 js 里 「cache」 信号只命中 **101** 次 ⇒ 没有任何 miss 归因。
 *   于是「首步 miss 从 37,239 涨到 217,307」这个唯一在恶化的指标，至今无法定位
 *   （阶段 06 实测：命中率其实没恶化 96.8~98.7%，恶化的是**每步未缓存输入的绝对值**
 *    resume 7,461 -> 23,844）。没有归因，就只能猜。
 *
 * ═══ 为什么挂 llm/stream ═══
 *   它是**唯一能拿到"真实 payload"**的钩子：
 *     dsh-llm/lib/index.js L2307: ctx.waterfall(this, "llm/stream", options,  => adapterStream(options, prepared))
 *   DSH 没有 Pi 那种 「before_payload」（K11）⇒ 要看发出去的东西，只能在这里。
 *
 * ═══ 纪律（照抄 Reasonix internal/agent/cache_shape.go 的注释）═══
 *   "a bare LogRewriteVersion change with no drained reason means only **local-only metadata**
 *    was touched (decision receipts, tool-call previews, Edited-message replaces),
 *    **which never reaches the provider and so must not be reported as a cache change**."
 *   ⇒ 本插件的对应物是：只有 **system / tools / 前面若干条消息** 变了才算缓存变化；
 *     会话内部记账（compaction/start、session/title 之类）**不得**报为缓存变化。
 *
 * ═══ 只读保证 ═══
 *   · 不改 options、不改任何 chunk（只做一次 「for await」 转发）
 *   · 任何异常一律 fail-open（直接 next()）
 *   · 开销：每次请求算 3 个短哈希（消息只取前 N 条 + 系统的前缀）
 * ══════════════════════════════════════════════════════════════════════════ */

/** FNV-1a 32 位；只做指纹，不需要抗碰撞。 */
function shapeHash(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16).padStart(8, "0")
}

/** 把一条消息压成"形状串"（只取角色 + 块类型 + 长度，不取正文 —— 正文长度变化才是缓存杀手）。 */
function messageShape(m) {
  const blocks = Array.isArray(m?.content) ? m.content : []
  const kinds = blocks.map((b) => {
    /*  缓存是【内容敏感】的 —— 只哈希"类型+长度"会漏报"等长内容替换"
       （实测踩到：system 从 "S" 改成 "Z" 长度不变，指纹却没变 ⇒ 该报的缓存失效漏了）。
       ⇒ 改成 长度 + 内容指纹；单条截前 8KB 控制开销（长度单独入哈希，尾部变化也能抓到）。 */
    if (b?.type === "text") return "t" + String(b.text ?? "").length + ":" + shapeHash(String(b.text ?? "").slice(0, 8192))
    if (b?.type === "reasoning") return "r" + String(b.text ?? "").length + ":" + shapeHash(String(b.text ?? "").slice(0, 8192))
    if (b?.type === "tool-call") return "c" + String(b.name ?? "") + ":" + String(b.arguments ?? "").length + ":" + shapeHash(String(b.arguments ?? "").slice(0, 8192))
    if (b?.type === "tool-result") { const j = JSON.stringify(b.content ?? ""); return "R" + String(b.toolCallId ?? "") + ":" + j.length + ":" + shapeHash(j.slice(0, 8192)) }
    return String(b?.type ?? "?")
  }).join(",")
  return (m?.role ?? "?") + "[" + kinds + "]"
}

/**
 * 算一次请求的指纹。
 * @param options - llm/stream 的 options（含 messages / tools）。
 * @returns 「{ system, tools, prefix, prefixLen, toolCount }」（全是短哈希）。
 */
function shapeOf(options) {
  const messages = Array.isArray(options?.messages) ? options.messages : []
  /* 系统提示：DSH 可能把它当独立 system 消息，也可能并进首条 —— 两种都覆盖。 */
  let systemText = ""
  for (const m of messages) {
    if (m?.role === "system") systemText += messageShape(m)
    else break
  }
  /* 工具清单：**必须先按名字排序**再哈希（顺序抖动会误报缓存失效；composer 已做排序，这里防御）。 */
  const tools = Array.isArray(options?.tools) ? options.tools : []
  const toolsKey = tools
    .map((t) => String(t?.function?.name ?? t?.name ?? "?"))
    .sort()
    .join("|")
  /* 前缀指纹的窗口。
   *   实测修正：原值 **8 太小** —— 新会话实测"每步稳定丢 ~1.3 万 tok"，
   *   却一条 cache-break 都不报，因为**变化发生在前 8 条之后**，这里根本看不见。
   *   提到 40（可用 DSH_RECLAIM_PREFIX_LEN 覆盖）后，前 40 条内任何变化都能捕获。
   *   为什么不取全长：老会话有 1000+ 条消息，全长比对没必要；而"每步变"的内容
   *   要么在很前（system / tools），要么在中部（注入 / 上下文），40 条足以覆盖。
   *   注：消息数不足 40 时按实际条数取，所以新会话等于全量比对。 */
  /*   诊断期：取**全长**（不再默认 40）。
   *   依据：实测 `firstDiff=-1`（前 40 条逐条完全相同）但 miss 仍有 1.3 万
   *   ⇒ 变化只可能在**窗口之外**（第 41 条起）。40 太短。
   *   开销：每条一次 FNV-1a（O(n)），1000 条 × 均 1KB ≈ 1MB ⇒ 毫秒级，可接受。
   *   定位到具体位置后再按需要收窄（或改用 DSH_RECLAIM_PREFIX_LEN 覆盖）。 */
  const prefixLen = Math.min(Math.max(1, Number(process.env.DSH_RECLAIM_PREFIX_LEN) || 1e9), messages.length)
  const prefixKey = messages.slice(0, prefixLen).map(messageShape).join("\u0001")
  /*   诊断：逐条的"角色:块类型/长度"摘要（不含内容哈希，只看形状）。
     用途：`prefix` 是个总哈希，只能回答"变没变"；这个数组能回答"**第几条**变了"。
      注意 messageShape 里内容只哈希前 8KB ⇒ 长消息的尾部变化它抓不到；
     这个摘要用【每块的长度】补齐那个盲区（长度一变就露馅，不需要内容）。 */
  const prefixDigest = messages.slice(0, prefixLen).map((m) => {
    const blocks = Array.isArray(m?.content) ? m.content : []
    return String(m?.role ?? "?") + ":"
      + blocks.map((b) => {
        const t = String(b?.text ?? b?.arguments ?? "")
        /*：**全文哈希**（FNV-1a，O(n) 但很快）。
           原来只放"长度"，而 messageShape 又只哈希前 8KB ⇒
           长消息的后半段变化**两处都抓不到**。
           实测线索：miss ≈ 1.3 万 tok，而当场只有一条 3.1 万字符的 user 消息
           ⇒ 量级吻合，但形状（长度）没变 ⇒ 必须比内容。 */
        return String(b?.type ?? "?") + "/" + t.length + "/" + shapeHash(t).slice(0, 8)
      }).join(",")
  })
  return {
    system: shapeHash(systemText),
    tools: shapeHash(toolsKey + "#" + tools.length),
    prefix: shapeHash(prefixKey),
    prefixLen,
    prefixDigest,
    toolCount: tools.length,
    /*  排序后的工具名串：让「工具定义到底变没变、变了什么」可判定（C4 修复）。 */
    toolsNames: toolsKey,
    at: Date.now(),
  }
}

/** 缓存归因状态（按 provider|model 分组，进程内）。 */
const shapeByRoute = new Map()
/** 最近的 CacheBreak 收据（环形，最多 64 条）。 */
const cacheReceipts = []
const CACHE_RECEIPT_MAX = 64

/* ══════════════════════════════════════════════════════════════════════════
 * R9：归因器升级（ 集中化）—— 补 Reasonix desktopContract 的三个字段
 *
 * 字段定义出处：'<工作区>\上下文治理\10-对标研究\_data\reasonix-desktopContract.json'
 *   CacheDiagnostics: { prefixHash, prefixChanged, prefixChangeReasons[], systemHash, toolsHash,
 *                       logRewriteVersion, toolSchemaTokens, cacheMissTokens, cacheHitTokens, sessionContext }
 *   ContextMaintenance: { status, action, trigger, operationId, inputTokens, resultTokens,
 *                         savedTokens, affectedToolResults, projectionVersion, cacheBreak, reason }
 *
 * ═══ logRewriteVersion 为什么重要 ═══
 *   Reasonix 的纪律原文（internal/agent/cache_shape.go）：
 *     "a bare LogRewriteVersion change with no drained reason means only **local-only metadata**
 *      was touched … which never reaches the provider and so must not be reported as a cache change."
 *   ⇒ 本插件的对应物：reclaim 自己对 wire（将要发出去的 messages）的改写版本号。
 *     只有它变了、而 system/tools/prefix 都没变 ⇒ **不报缓存变化**（本地元数据级改动）。
 *
 * ═══ cacheHit/MissTokens 的来源 ═══
 *   usage 在**请求结束后**才回来（llm/stream 的 chunk 里），而收据是**请求前**记的
 *   ⇒ 只回填到"本帧刚记的那条收据"（per-route 精确匹配），不猜测、不错配。
 * ══════════════════════════════════════════════════════════════════════════ */

/** wire 改写版本号：**代码改了必须手改这里**（用于区分"本插件改了改写逻辑"与"内容变了"）。 */
const WIRE_REWRITE_VERSION = 1


/** 按 routeKey 记 provider 上一次报的 usage（prompt 侧总量 + 缓存命中/未命中）。 */
const usageByRoute = new Map()
/** 按 routeKey 记住"本帧刚记的那条收据"，供 usage 回填（null = 本帧没记）。 */
const lastReceiptByRoute = new Map()

/**
 * 从 chunk 里抠 usage（provider 字段名各版本不一，逐种兼容）。
 * @param chunk - llm 流的 chunk。
 * @returns '{ promptTokens, cacheHit, cacheMiss, outputTokens, reasoningTokens }' 或 null。
 */
function usageOfChunk (chunk) {
  const cands = [chunk?.usage, chunk?.message?.usage, chunk?.data?.usage, chunk?.response?.usage]
  let u = null
  for (const c of cands) if (c !== null && typeof c === 'object') { u = c; break }
  if (u === null && typeof chunk?.type === 'string' && chunk.type === 'usage') u = chunk
  if (u === null || typeof u !== 'object') return null
  const num = (...keys) => {
    for (const k of keys) {
      const v = u[k]
      if (typeof v === 'number' && Number.isFinite(v)) return v
    }
    return null
  }
  const promptTokens = num('prompt_tokens', 'promptTokens', 'totalTokens', 'total_tokens')
  /*  DSH 规范化后的字段名是 **camelCase**，而且语义和 OpenAI 不同 ——
     出处：会话记录里的 usage 事件（实测形状）
       "usage":{"inputTokens":6323,"outputTokens":2,"totalTokens":8629,"cacheReadTokens":2304,"reasoningTokens":0}
     其中 inputTokens = **未命中**部分、cacheReadTokens = 命中、totalTokens = 命中+未命中+输出。
     第一版只抽平铺的 prompt_cache_hit_tokens ⇒ 真机上一直是 hit=? miss=?（白打了一版）。 */
  const det = (u.prompt_tokens_details !== null && typeof u.prompt_tokens_details === 'object') ? u.prompt_tokens_details : null
  const nestedHit = det !== null && typeof det.cached_tokens === 'number' ? det.cached_tokens : null
  const nestedMiss = det !== null && typeof det.uncached_tokens === 'number' ? det.uncached_tokens : null
  const cacheHit = num('cacheReadTokens', 'cacheRead', 'prompt_cache_hit_tokens', 'promptCacheHitTokens', 'cache_read_input_tokens', 'cacheReadInputTokens', 'cacheHitTokens') ?? nestedHit
  const outputTokens = num('outputTokens', 'completion_tokens', 'completionTokens', 'output_tokens')
  /* DSH：inputTokens 就是未命中；OpenAI 系：prompt_cache_miss_tokens；再不行用 total-hit-output 反推。 */
  const cacheMiss = num('prompt_cache_miss_tokens', 'promptCacheMissTokens', 'cacheMissTokens', 'cacheMiss', 'cache_creation_input_tokens', 'cacheCreationInputTokens')
    ?? nestedMiss
    ?? (cacheHit !== null && promptTokens !== null
      ? Math.max(0, promptTokens - cacheHit - (outputTokens ?? 0)) : null)
  const reasoningTokens = num('reasoningTokens', 'reasoning_tokens')
  if (promptTokens === null && cacheHit === null && cacheMiss === null) return null
  return {
    promptTokens: promptTokens === null && cacheHit !== null && cacheMiss !== null ? cacheHit + cacheMiss : promptTokens,
    cacheHit,
    cacheMiss,
    outputTokens,
    reasoningTokens,
  }
}

/**
 * 记一次 usage，并回填到本帧刚记的那条收据（只回填 exact match，不错配）。
 *：**把命中/未命中打出来** —— 这是成本的第一性指标：
 *   DeepSeek 价目 cache_hit ¥0.04/1M vs 未命中 ¥2/1M（**50 倍**）、output ¥8/1M（**200 倍**）。
 *   实测 Reasonix 单请求 prompt 508,074 里 cache_miss 只有 **554**（命中 99.89%）⇒ 这才是"便宜"的根因；
 *   所以"每步的 cache_miss 是多少"必须随时可见（决定"改历史"到底划不划算）。
 * @param routeKey - 路由键。
 * @param u - usageOfChunk 的结果。
 */
/*   诊断：aux 调用的 purpose / 来源插件。
 * 实测：aux 路由（= 没有 tools 的调用）命中率只有 5~15%，且 out 里带 1,844~3,479 的 reasoning
 * ⇒ 没被 dsh-aux-degrade 降到 off。但 aux-degrade 的配置是对的（purposes 空 ⇒ 默认
 * compaction/session-title/title；auxPlugins 空 ⇒ 默认 dsh-prompt-enhance）
 * ⇒ 只能把实际 purpose / source.plugin 打出来才知道漏在哪类。
 *  只读诊断，不改任何行为；每个新组合只打一次。 */
const auxProbeLogged = new Set()
function purposeOf (options) {
  const p = options?.purpose
  if (typeof p === 'string' && p.length > 0) return p
  for (const m of (Array.isArray(options?.messages) ? options.messages : [])) {
    const sp = m?.source?.plugin
    if (typeof sp === 'string' && sp.length > 0) return 'src:' + sp
  }
  return '-'
}

function recordUsage (routeKey, u, purpose) {
  usageByRoute.set(routeKey, u)
  try {
    /*   诊断：把"这一次请求的工具集"直接拼进 usage 行。
       为什么放这里：reclaim/usage 是**每个请求都会打**的那一行，而 miss 也在这一行 ⇒
       两者天然对齐，一眼就能看出"miss 大是不是因为 tools 变了"。
       之前放在 composer 的 maskAssemblyTools 里 ⇒ 那函数在 assembly.tools 为空时 early return，
       基本跑不到（实测只触发 1 次），白改。 */
    const shp = shapeByRoute.get(routeKey)
    const toolsNote = (shp === undefined || shp === null)
      ? ''
      : ' tools=' + shp.toolCount + ' toolsHead=' + String(shp.toolsNames ?? '').split('|').slice(0, 5).join(',')
        /*   诊断：逐条定位结果（由 compareShape 无条件算好）。
           firstDiff=-1 ⇒ 前 N 条逐条形状相同（差异在窗口之外或盲区里）；
           firstDiff=K  ⇒ 从第 K+1 条起就不同了 ⇒ 直接指认罪魁。 */
        + ' firstDiff=' + (shp.firstDiffAt === undefined ? '?' : shp.firstDiffAt)
        + (typeof shp.firstDiffAt === 'number' && shp.firstDiffAt >= 0
          ? ' prev=' + String(shp.firstDiffPrev ?? '').slice(0, 56) + ' now=' + String(shp.firstDiffNow ?? '').slice(0, 56)
          : '')
    console.error('[reclaim/usage] route=' + routeKey
      + ' prompt=' + (u.promptTokens ?? '?')
      + ' hit=' + (u.cacheHit ?? '?') + ' miss=' + (u.cacheMiss ?? '?') + toolsNote
      + ' out=' + (u.outputTokens ?? '?') + (u.reasoningTokens === null ? '' : '（reasoning ' + u.reasoningTokens + '）')
      + (typeof u.cacheHit === 'number' && typeof u.cacheMiss === 'number' && u.cacheHit + u.cacheMiss > 0
        ? ' 命中率=' + (u.cacheHit / (u.cacheHit + u.cacheMiss) * 100).toFixed(2) + '%'
        : '')
      + (() => {
        if (purpose === undefined || purpose === null) return ''
        const key = routeKey + '|' + purpose
        if (auxProbeLogged.has(key)) return ''
        auxProbeLogged.add(key)
        return '  purpose=' + purpose
      })())
  } catch { /* ignore */ }
  const receipt = lastReceiptByRoute.get(routeKey)
  if (receipt === null || receipt === undefined) return
  if (typeof u.promptTokens === 'number') receipt.promptTokens = u.promptTokens
  if (typeof u.cacheHit === 'number') receipt.cacheHitTokens = u.cacheHit
  if (typeof u.cacheMiss === 'number') receipt.cacheMissTokens = u.cacheMiss
}

/** provider 上一次报的 prompt 侧总量（给 R10 的 otherTokens 用）；没有则 null。 */
function lastPromptTokensOf (routeKey) {
  const u = usageByRoute.get(routeKey)
  return (u !== undefined && typeof u.promptTokens === 'number') ? u.promptTokens : null
}


/**
 * 与上一次同路由的指纹比较，产出 reasons。
 * @param shape - 本次指纹（需含 routeKey）。
 * @returns reasons 数组（空 = 前缀未变）。
 */
function compareShape(shape) {
  const prev = shapeByRoute.get(shape.routeKey)
  shapeByRoute.set(shape.routeKey, shape)
  if (prev === undefined) return ["first-seen"]
  const reasons = []
  if (prev.system !== shape.system) reasons.push("system")
  if (prev.tools !== shape.tools) {
    reasons.push("tools")
    /*  C4 修复：给出【具体差异】（数量 + 增删了哪些名字）——
       没有它就只能看到"变了"，无法判断是宿主时序、composer 抖动、还是真的换了工具集。 */
    const before = new Set(String(prev.toolsNames ?? "").split("|").filter(Boolean))
    const after = new Set(String(shape.toolsNames ?? "").split("|").filter(Boolean))
    const added = [...after].filter((x) => !before.has(x))
    const removed = [...before].filter((x) => !after.has(x))
    shape.toolsDelta = {
      count: prev.toolCount + "->" + shape.toolCount,
      addedN: added.length, removedN: removed.length,
      added: added.slice(0, 6), removed: removed.slice(0, 6),
    }
  }
  /*   诊断：**无条件**逐条比对，定位"第几条开始不同"。
     为什么不放进 `prev.prefix !== shape.prefix` 分支：实测 prefix 总哈希**常常相同**，
     但服务端依然 miss 1.3 万 —— 说明差异落在 messageShape 的盲区里
     （它每条只哈希前 8KB）。prefixDigest 用的是"每块长度"，正好补上那个盲区。
     无条件算 ⇒ 每次请求都能看到定位结果，不用等它"恰好报 prefix"。 */
  {
    const a = Array.isArray(prev.prefixDigest) ? prev.prefixDigest : []
    const b = Array.isArray(shape.prefixDigest) ? shape.prefixDigest : []
    let firstDiff = -1
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) { firstDiff = i; break }
    }
    shape.firstDiffAt = firstDiff
    shape.firstDiffPrev = firstDiff >= 0 ? String(a[firstDiff] ?? '(无)').slice(0, 80) : ''
    shape.firstDiffNow = firstDiff >= 0 ? String(b[firstDiff] ?? '(无)').slice(0, 80) : ''
  }
  if (prev.prefix !== shape.prefix) reasons.push("prefix")
  /*  R9：wire 改写版本 —— 区分"内容真的变了"与"本插件的改写**逻辑**升级了"。
     · 'wire'：本帧真的改写了将要发出的消息（内容变化 ⇒ 会破缓存 ⇒ 值得看）
     · 'rewrite-log'：只是代码版本号变了（Reasonix 的 LogRewriteVersion 纪律：
        "bare version change with no drained reason means only local-only metadata was touched"
       ⇒ **不得**报成缓存变化） */
  if (prev.wireVersion !== shape.wireVersion) reasons.push("wire")
  if (prev.logRewriteVersion !== shape.logRewriteVersion) reasons.push("rewrite-log")
  return reasons
}

/**
 * 记一条收据（只在"前缀真的变了"或首次时记；正常增长不记，避免噪音）。
 * @param shape - 本次指纹。
 * @param reasons - compareShape 的结果。
 */
function recordCacheReceipt(shape, reasons, payload) {
  if (reasons.length === 0) {
    /* 本帧没记收据 ⇒ 清空回填位（usage 回来时不许错配到上一次的收据上）。 */
    lastReceiptByRoute.set(shape.routeKey, null)
    return
  }
  /* "prefix" 单独出现时通常是正常增长（新消息进前缀窗口）—— 仍记，但标注为 growth。
      R9：'wire'（本插件真改了消息）算值得看；'rewrite-log'（只是代码版本号变）**不算**
     —— 那正是 Reasonix 说的 "local-only metadata"。 */
  const noteworthy = reasons.some((r) => r === "system" || r === "tools" || r === "first-seen" || r === "wire")
  const receipt = {
    at: shape.at,
    route: shape.routeKey,
    reasons,
    toolCount: shape.toolCount,
    prefixLen: shape.prefixLen,
    ...(shape.toolsDelta ? { toolsDelta: shape.toolsDelta } : {}),
    /*  R9 三字段：改写版本 + 工具定义代价 + 这次维护是否破缓存。 */
    logRewriteVersion: shape.logRewriteVersion,
    wireVersion: shape.wireVersion,
    toolSchemaTokens: payload !== undefined && payload !== null && payload.toolsTokens > 0 ? payload.toolsTokens : null,
    cacheBreak: shape.cacheBreak === true,
    noteworthy,
  }
  cacheReceipts.push(receipt)
  if (cacheReceipts.length > CACHE_RECEIPT_MAX) cacheReceipts.shift()
  lastReceiptByRoute.set(shape.routeKey, receipt)
  /* 只在"值得看"的变化上打日志（system/tools/wire 变了 = 真破了缓存）。 */
  if (noteworthy) {
    console.error("[reclaim/cache-break] " + new Date(shape.at).toISOString()
      + " route=" + shape.routeKey + " reasons=" + reasons.join("+")
      + " tools=" + shape.toolCount + " prefixLen=" + shape.prefixLen
      + (receipt.toolSchemaTokens !== null ? " 工具定义≈" + receipt.toolSchemaTokens + " tok" : "")
      + " logRewriteVersion=" + String(shape.logRewriteVersion)
      + " cacheBreak=" + (shape.cacheBreak === true ? "YES" : "no")
      + (shape.toolsDelta ? " toolsDelta=" + JSON.stringify(shape.toolsDelta) : ""))
  }
}

/**
 * 包装 chunk 流：原样转发，不观察、不改动（v1 只做指纹；usage 与收据的事后关联由脚本做）。
 * @param inner - 上游 chunk 流。
 * @returns 原样转发的异步生成器。
 */
/**
 *：**tool 配对守卫** —— provider 的硬要求：
 * "An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'"
 * （实测报错原文）。本插件的改写里凡是"删/换块"的都要保证配对不断：
 *   · R5 stale：call 换成 digest + result 删除（成对 ✓）
 *   · R5 repeated：call 与 result 都删（**原来没 atomicKey ⇒ 可能半截** ⇒ 已补）
 *   · R13 归档：只换 result 的文本，块不删 ✓
 *   · R8 快照去重：只删"不含 tool-result 的 user 消息" ✓
 * 这个函数在**改写前后各跑一次**：若"改前配对、改后不配对"即本插件所致；若改前就不配对 ⇒ 别人（DSH/压缩）干的。
 * @param messages - wire 层消息。
 * @returns '{ calls, results, missing, orphan }'。
 */
function checkToolPairing (messages) {
  const calls = new Set()
  const results = new Set()
  for (const m of (Array.isArray(messages) ? messages : [])) {
    const blocks = Array.isArray(m?.content) ? m.content : []
    for (const b of blocks) {
      if (b?.type === 'tool-call' && typeof b.id === 'string' && b.id !== '') calls.add(b.id)
      else if (b?.type === 'tool-result' && typeof b.toolCallId === 'string' && b.toolCallId !== '') results.add(b.toolCallId)
    }
  }
  return {
    calls: calls.size,
    results: results.size,
    missing: [...calls].filter((id) => !results.has(id)),
    orphan: [...results].filter((id) => !calls.has(id)),
  }
}

async function* passthrough(inner, routeKey, purpose) {
  /* await 兼容两种瀑布实现：next() 直接返回 stream，或返回 Promise<stream>。 */
  const source = await inner
  let lastUsage = null
  for await (const chunk of source) {
    /*  R9：顺手收 provider 的 usage（prompt 总量 + 缓存命中/未命中），
       请求结束后回填到本帧的收据上 —— 只读、不改 chunk、异常不影响转发。 */
    try { const u = usageOfChunk(chunk); if (u !== null) lastUsage = u } catch { /* ignore */ }
    yield chunk
  }
  if (lastUsage !== null && routeKey !== undefined) {
    try { recordUsage(routeKey, lastUsage, purpose) } catch { /* ignore */ }
  }
}

/**
 *：**payload 构成观测** —— 直接回答"大头是谁"。
 *
 * 为什么需要：面板给的占比是【会话记录视角】，而会话记录里存的是**原始消息**
 * （历史 reasoning 全在），不能代表真正发出去的 payload。实测探针会话（16 步 / 23 次工具）：
 *   面板说 助手消息 33.9% > 工具定义 25.7% > 工具结果 21.9%，
 *   而 agent 侧的 reasoning 剥离补丁（只回传最后 1 条）**没有任何日志** ⇒ 无法核对。
 * 这条日志量的是 llm/stream 收到的 options（= 即将序列化发出的东西），三类都能对上。
 *
 * 纪律：只读、不改 options、异常 fail-open。
 */
/**
 *：**离线重放"发送时"的形态** —— 让 payload 日志自证。
 *
 * 为什么必须自己算：序列化发生在 llm/stream **之后**（dsh-llm/lib/index.js L2307 的
 * waterfall 只把原始 options 给钩子；真正调 serializeMessages 的是
 * dsh-llm-deepseek/lib/index.js L587/L619，在 adapter 内部）⇒ 在钩子里看到的
 * reasoning 块数是【剥离前】的原始值，无法判断剥离有没有生效。
 * 而把日志加进官方包会被门禁（G-06 的回退点往返）还原 ⇒ 只能在钩子里【照同一套规则重算】。
 *
 * 规则出处（逐条照抄，不自创）：
 *   · reasoning：reasoningCarrierIndexes() —— 从后往前取 keepLast 条【真有思维链】的 assistant，
 *     外加【最新一条 assistant 恒为载体】。keepLast 读 DSH_LLM_DEEPSEEK_REASONING_KEEP_LAST（默认 1）。
 *   · 工具参数：argBudgetFence() —— 最后一次人类 user 消息为栅栏，只剪它【之前】的
 *     write/edit；阈值读 DSH_LLM_DEEPSEEK_ARG_THRESHOLD（默认 4096）。
 * 这里只做【计数与长度估计】，不改任何东西。
 */
function simulateWireShape(messages) {
  const out = { keepLast: 1, threshold: 4096, reasBlocksRaw: 0, reasCharsRaw: 0, reasBlocksWire: 0, reasCharsWire: 0, argOverRaw: 0, argOverWire: 0 }
  try {
    out.keepLast = Number(process.env.DSH_LLM_DEEPSEEK_REASONING_KEEP_LAST ?? 1)
    out.threshold = Number(process.env.DSH_LLM_DEEPSEEK_ARG_THRESHOLD ?? 4096)
    const keepLast = out.keepLast
    const threshold = out.threshold
    for (const m of messages) {
      if (m?.role !== 'assistant') continue
      for (const b of (Array.isArray(m.content) ? m.content : [])) {
        if (b?.type === 'reasoning') { out.reasBlocksRaw += 1; out.reasCharsRaw += String(b.text ?? '').length }
      }
    }
    /* reasoning 发送时（照抄 reasoningCarrierIndexes 的语义） */
    const carriers = new Set()
    if (keepLast > 0) {
      let seen = 0, lastAssistant = -1
      for (let i = messages.length - 1; i >= 0 && seen < keepLast; i -= 1) {
        const m = messages[i]
        if (m?.role !== 'assistant') continue
        if (lastAssistant < 0) lastAssistant = i
        const has = (Array.isArray(m.content) ? m.content : []).some((b) => b?.type === 'reasoning' && typeof b.text === 'string' && b.text.length > 0)
        if (!has) continue
        carriers.add(i); seen += 1
      }
      if (lastAssistant >= 0) carriers.add(lastAssistant)
    }
    for (const i of carriers) {
      const m = messages[i]
      if (m?.role !== 'assistant') continue
      for (const b of (Array.isArray(m.content) ? m.content : [])) {
        if (b?.type === 'reasoning') { out.reasBlocksWire += 1; out.reasCharsWire += String(b.text ?? '').length }
      }
    }
    /* 参数：栅栏之前才剪（照抄 argBudgetFence + isHumanUserMessage 的语义） */
    let fence = -1
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]
      if (m?.role !== 'user') continue
      const blocks = Array.isArray(m.content) ? m.content : []
      const hasToolResult = blocks.some((b) => b?.type === 'tool-result')
      if (m.source?.kind === 'user' || !hasToolResult) { fence = i; break }
    }
    for (let i = 0; i < messages.length; i += 1) {
      const m = messages[i]
      if (m?.role !== 'assistant') continue
      for (const b of (Array.isArray(m.content) ? m.content : [])) {
        if (b?.type !== 'tool-call') continue
        const len = String(b.arguments ?? '').length
        const isTrimTarget = b.name === 'write' || b.name === 'edit'
        const inFrozenPrefix = fence > 0 && i < fence
        if (isTrimTarget && inFrozenPrefix) { if (len > threshold) out.argOverWire += 1 } else if (len > threshold) out.argOverRaw += 1
      }
    }
  } catch { /* fail-open */ }
  return out
}

/* ══════════════════════════════════════════════════════════════════════════
 * R11：token 计价口径 —— CJK **2 字符/token**（ 集中化）
 *
 * ═══ 为什么是 2 ═══
 *   普查得到三个口径（各自出处都在实装代码里）：
 *     · DSH/Pi 系（含 dsh-context-xray、triage）：4 字符/token
 *     · '@aiwayds/dsh-dcp'：2 字符/token
 *     · 'dsh-token-budget-tools' / 'dsh-text-stats'：0.6 token/字 ≈ 1.67 字符/token
 *   ⇒ 取**中位 2**。中文用户的实际载荷里 CJK 占比很高，用 4 会把中文载荷少算一半，
 *     "省了多少 token"这类结论会系统性偏乐观。
 *
 * ═══ 纪律 ═══
 *   只影响**估算与日志**。'shapeHash' 的指纹口径（长度 + 内容指纹）**一个字节都不动** ——
 *   那是"内容变了没"的判据，与计价无关；换口径去动它等于把缓存归因做坏。
 * ══════════════════════════════════════════════════════════════════════════ */

/** CJK 计价：2 字符/token（普查三口径取中位）。 */
const CJK_PER_TOKEN = 2
/** 非 CJK 计价：4 字符/token（与 DSH/Pi 一致）。 */
const OTHER_PER_TOKEN = 4
/** CJK 判定（与 dsh-context-triage 的 CJK_RE 同区间，外加全角标点区）。 */
const CJK_CHAR_RE = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/

/**
 * 估一段文本的 token（CJK 2 字符/token、其余 4 字符/token）。
 * 用 code point 计数（for..of），emoji 与代理对不会被算成 2 个字符。
 * @param text - 任意文本。
 * @returns 估算 token（整数）。
 */
function estimateTextTokens (text) {
  const s = String(text ?? '')
  if (s.length === 0) return 0
  let cjk = 0
  let other = 0
  for (const ch of s) { if (CJK_CHAR_RE.test(ch)) cjk += 1; else other += 1 }
  return Math.ceil(cjk / CJK_PER_TOKEN) + Math.ceil(other / OTHER_PER_TOKEN)
}

/**
 * 估一组块的 token（块词表与 dsh-llm 一致：text/reasoning/tool-call/tool-result/image）。
 * @param blocks - 消息的 content 数组（或其子数组）。
 * @returns 估算 token。
 */
function estimateBlocksTokens (blocks) {
  let total = 0
  for (const b of (Array.isArray(blocks) ? blocks : [])) {
    if (b === null || typeof b !== 'object') continue
    if (b.type === 'text' || b.type === 'reasoning') total += estimateTextTokens(b.text)
    else if (b.type === 'tool-call') {
      total += estimateTextTokens(typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments ?? {}))
      total += Math.max(1, Math.ceil(String(b.name ?? '').length / OTHER_PER_TOKEN))
    } else if (b.type === 'tool-result') total += estimateBlocksTokens(b.content)
    else { try { total += estimateTextTokens(JSON.stringify(b)) } catch { /* 循环引用等：按 0 计 */ } }
  }
  return total
}

/** 估一条消息的 token（含每条消息的固定开销 4，照抄 xray 的 BLOCK_OVERHEAD 口径）。 */
function estimateMessageTokens (m) {
  if (m === null || typeof m !== 'object') return 0
  return estimateBlocksTokens(m.content) + 4
}

/**
 * 估一条消息数组的 token。
 * @param messages - 消息数组。
 * @returns 估算 token。
 */
function estimateMessagesTokens (messages) {
  let total = 0
  for (const m of (Array.isArray(messages) ? messages : [])) total += estimateMessageTokens(m)
  return total
}

/**
 * 估一个工具定义的 token（名字 + 描述 + 参数 schema）。
 * @param tool - wire 形状的工具（'function' 包一层或裸形）。
 * @returns 估算 token。
 */
function estimateToolSchemaTokens (tool) {
  const fn = (tool !== null && typeof tool === 'object' && tool.function !== undefined) ? tool.function : (tool ?? {})
  let params = ''
  try { params = JSON.stringify(fn.parameters ?? {}) } catch { params = '' }
  return estimateTextTokens(String(fn.name ?? '')) + estimateTextTokens(String(fn.description ?? ''))
    + estimateTextTokens(params) + 4
}

/* ══════════════════════════════════════════════════════════════════════════
 * R10：8 分组归因（ 集中化）
 *
 * 抄自 'dsh-context-xray@1.0.0-rc.2' 的 analyzer（classifyMessage + CATEGORY_LABELS）：
 * 8 组 = System Prompt / Conversation / Tool Schemas / Skills / Memory·Injections /
 *        Workspace Instructions / Attachments / Reserved·Other
 * 算法：按 token **降序** + 'otherTokens = max(0, knownTotal - categoriesTotal)'（差额归 other）。
 *
 * ═══ 与 xray 的差别（数据来源）═══
 *   xray 从 assembly（sections/contexts/tools）算；本插件在 'llm/stream' 只有**真实 payload**
 *   ⇒ 系统提示在 messages 的 system 消息里、工具在 options.tools 里 —— 分组口径不变，
 *     但量的就是"真正发出去的那一份"。
 * 额外价值（xray 也有）：**每个工具 schema 的 token + 本 payload 内是否真被调用**
 *   ⇒ 直接支撑"常驻但从不调用的工具"这类优化决策。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 分组标签（照抄 xray 的 CATEGORY_LABELS，含文案）。 */
const GROUP_LABELS = {
  system: 'System Prompt',
  conversation: 'Conversation',
  tools: 'Tool Schemas',
  skills: 'Skills',
  memory: 'Memory / Injections',
  workspace: 'Workspace Instructions',
  attachments: 'Attachments',
  other: 'Reserved / Other',
}

/**
 * 把一条消息归到 8 组之一（照抄 xray classifyMessage 的判据顺序）。
 * @param m - wire 层消息。
 * @returns 组 key。
 */
function groupOfMessage (m) {
  const blocks = Array.isArray(m?.content) ? m.content : []
  if (blocks.some((b) => b?.type === 'image' || b?.type === 'image-ref' || b?.type === 'image-url')) return 'attachments'
  const kind = (m !== null && typeof m === 'object' && m.source !== null && typeof m.source === 'object'
    && typeof m.source.kind === 'string') ? m.source.kind : null
  if (kind === 'agent-instructions') return 'workspace'
  if (kind === 'skill-catalog' || kind === 'skill-invocation') return 'skills'
  if (kind === 'plugin' || kind === 'memory' || kind === 'recall' || kind === 'relay') return 'memory'
  if (m?.role === 'system') return 'system'
  return 'conversation'
}

/** 内置工具名（照抄 xray toolSourceOf 的集合，用于'来源'标注）。 */
const BUILTIN_TOOL_NAMES = new Set([
  'bash', 'read', 'write', 'edit', 'glob', 'grep', 'todo', 'task', 'skill', 'subagent',
  'web_search', 'web_fetch', 'pwsh', 'fs', 'goal', 'jobs', 'workflow', 'ralph', 'ask_user',
  'str_replace_editor',
])

/**
 * 工具来源（builtin / mcp / plugin）—— 只按名字前缀推断（运行时 API 不暴露注册方）。
 * @param name - 工具名。
 * @returns 'builtin' | 'mcp' | 'plugin'。
 */
function toolSourceOf (name) {
  const lower = String(name ?? '').toLowerCase()
  if (lower.startsWith('mcp__') || lower.startsWith('mcp_') || lower.startsWith('mcp-')) return 'mcp'
  return BUILTIN_TOOL_NAMES.has(lower) ? 'builtin' : 'plugin'
}

/**
 * 算一次 payload 的 8 分组构成 + 每个工具的 schema 代价。
 * @param options - 'llm/stream' 的 options（含 messages / tools）。
 * @param sessionTotal - provider 上一次报的 prompt 侧总量（拿不到传 null）。
 * @returns '{ entries, perTool, toolsTokens, knownTotal, otherSource }'。
 */
function attributeGroups (options, sessionTotal) {
  const groups = new Map()
  const add = (k, v) => groups.set(k, (groups.get(k) ?? 0) + v)
  const messages = Array.isArray(options?.messages) ? options.messages : []
  for (const m of messages) add(groupOfMessage(m), estimateMessageTokens(m))

  /* 本 payload 内真被调用过的工具名（tool-call 块）。 */
  const calledNames = new Set()
  for (const m of messages) {
    const blocks = Array.isArray(m?.content) ? m.content : []
    for (const b of blocks) if (b?.type === 'tool-call') calledNames.add(String(b.name ?? ''))
  }

  const tools = Array.isArray(options?.tools) ? options.tools : []
  const perTool = []
  let toolsTokens = 0
  for (const t of tools) {
    const fn = (t !== null && typeof t === 'object' && t.function !== undefined) ? t.function : (t ?? {})
    const name = String(fn.name ?? '?')
    const tokens = estimateToolSchemaTokens(t)
    toolsTokens += tokens
    perTool.push({ name, tokens, source: toolSourceOf(name), called: calledNames.has(name) })
  }
  add('tools', toolsTokens)

  let categoriesTotal = 0
  for (const v of groups.values()) categoriesTotal += v
  const hasProvider = typeof sessionTotal === 'number' && Number.isFinite(sessionTotal) && sessionTotal > 0
  const knownTotal = hasProvider ? sessionTotal : categoriesTotal
  /* 差额归 other（照抄 xray：knownTotal 缺省时就是"已知合计"，故 other 恒为 0 或正数）。 */
  const otherTokens = Math.max(0, knownTotal - categoriesTotal)
  if (otherTokens > 0 || (groups.get('other') ?? 0) > 0) add('other', otherTokens)

  const entries = [...groups.entries()]
    .map(([key, tokens]) => ({ key, label: GROUP_LABELS[key] ?? key, tokens }))
    .sort((a, b) => b.tokens - a.tokens)
  return {
    entries,
    perTool,
    toolsTokens,
    knownTotal,
    otherSource: hasProvider ? 'provider-prompt-tokens(上一帧)' : 'none(按已知合计)',
  }
}

/**
 * 渲染 8 分组归因日志（一行）。只读、异常由调用方兜住。
 * @param options - 'llm/stream' 的 options。
 * @param sessionTotal - provider 上一次报的 prompt 总量（无则 null）。
 * @returns '{ line, groups, toolsTokens }'。
 */
function renderGroupLine (options, sessionTotal) {
  const { entries, perTool, toolsTokens, otherSource } = attributeGroups(options, sessionTotal)
  const parts = entries.map((e) => e.label + '=' + e.tokens)
  const neverCalled = perTool.filter((t) => !t.called)
  let neverTokens = 0
  for (const t of neverCalled) neverTokens += t.tokens
  const top = neverCalled.slice().sort((a, b) => b.tokens - a.tokens).slice(0, 5)
    .map((t) => t.name + '(' + t.tokens + 'tok,' + t.source + ')')
  const line = '[reclaim/groups] ' + parts.join('｜')
    + '｜工具 ' + perTool.length + ' 个/' + toolsTokens + ' tok'
    + '（本 payload 未调用 ' + neverCalled.length + ' 个/占 ' + neverTokens + ' tok'
    + (top.length > 0 ? '；最贵的未调用：' + top.join('、') : '') + '）'
    + '｜Reserved/Other 口径=' + otherSource
  return { line, groups: entries, toolsTokens }
}

const PAYLOAD_STATS = { calls: 0, logged: 0 }

function notePayloadShape(options) {
  const out = {
    groups: [],
    toolsTokens: 0,
    messages: Array.isArray(options?.messages) ? options.messages.length : 0,
  }
  try {
    const messages = Array.isArray(options?.messages) ? options.messages : []
    /*   修 bug：'sim' 原先声明在下面的统计循环**之后**，而循环里用到了
       'sim.threshold' ⇒ const 的 TDZ 抛 ReferenceError ⇒ 被 catch 吞掉 ⇒
       '[reclaim/payload]' 这条日志**从未打印过**（实测日志里零条）。提前到用之前。 */
    const sim = simulateWireShape(messages)
    let reasBlocks = 0, reasChars = 0, textChars = 0
    let reasTokens = 0, textTokens = 0
    let resTokens = 0
    let argCalls = 0, argChars = 0, argOver = 0
    let resCount = 0, resChars = 0, systemChars = 0
    for (const m of messages) {
      const content = Array.isArray(m?.content) ? m.content : []
      for (const b of content) {
        if (b?.type === 'reasoning') { reasBlocks += 1; reasChars += String(b.text ?? '').length; reasTokens += estimateTextTokens(b.text) }
        else if (b?.type === 'text') {
          const len = String(b.text ?? '').length
          textChars += len
          textTokens += estimateTextTokens(b.text)
          if (m?.role === 'system') systemChars += len
        } else if (b?.type === 'tool-call') {
          const a = String(b.arguments ?? '')
          argChars += a.length; argCalls += 1
          if (a.length > sim.threshold) argOver += 1
        } else if (b?.type === 'tool-result') {
          const raw = b.content
          const len = typeof raw === 'string' ? raw.length : JSON.stringify(raw ?? '').length
          resChars += len; resCount += 1; resTokens += estimateTextTokens(typeof raw === 'string' ? raw : JSON.stringify(raw ?? ''))
        }
      }
    }
    const tools = Array.isArray(options?.tools) ? options.tools : []
    let toolsChars = 0
    for (const t of tools) { try { toolsChars += JSON.stringify(t ?? {}).length } catch { /* skip */ } }
    /*  R10：8 分组归因 + 每工具 schema 代价（provider 总量取"上一帧"报的 prompt tokens）。 */
    const groupInfo = renderGroupLine(options, lastPromptTokensOf(routeKeyOf(options)))
    out.groups = groupInfo.groups
    out.toolsTokens = groupInfo.toolsTokens
    const st = PAYLOAD_STATS
    st.calls += 1
    /*  前 10 次都记 —— 探针会话通常只有 5~10 次请求，只记前 3 次会看不到"原始 N 块 ⇒ 预计 M 块"的对比（实测就被这个挡住过）。 */
    if (st.logged >= 10 && st.calls % 20 !== 0) return out
    st.logged += 1
    console.error('[reclaim/payload] 请求 ' + st.calls + ' 次｜消息 ' + messages.length + ' 条'
      + '｜系统提示 ' + systemChars + ' 字符/≈' + estimateTextTokens(systemCharsText(messages)) + ' tok'
      + '｜工具定义 ' + tools.length + ' 个/' + toolsChars + ' 字符/≈' + out.toolsTokens + ' tok'
      + '｜工具参数 ' + argCalls + ' 个/' + argChars + ' 字符（超 ' + sim.threshold + ' 的 共' + argOver + ' 个/其中在冻结前缀内会被截 ' + sim.argOverWire + ' 个）'
      + '｜工具结果 ' + resCount + ' 个/' + resChars + ' 字符/≈' + resTokens + ' tok'
      + '｜reasoning 原始 ' + reasBlocks + ' 块/' + reasChars + ' 字符/≈' + reasTokens + ' tok ⇒ 发送时预计 ' + sim.reasBlocksWire + ' 块/' + sim.reasCharsWire + ' 字符（keepLast=' + sim.keepLast + '）'
      + '｜助手文本 ' + textChars + ' 字符/≈' + textTokens + ' tok'
      + '｜合计估算 ≈' + (out.toolsTokens + resTokens + reasTokens + textTokens) + ' tok（CJK ' + CJK_PER_TOKEN + ' 字符/token）')
    console.error(groupInfo.line)
  } catch { /* fail-open：日志绝不影响主流程 */ }
  return out
}

/**
 * 把 system 消息的纯文本拼起来（只给日志用）。
 * @param messages - wire 层消息。
 * @returns 系统提示正文。
 */
function systemCharsText (messages) {
  let text = ''
  for (const m of messages) {
    if (m?.role !== 'system') break
    const blocks = Array.isArray(m?.content) ? m.content : []
    for (const b of blocks) if (b?.type === 'text') text += String(b.text ?? '')
  }
  return text
}

/* ══════════════════════════════════════════════════════════════════════════
 * R1 + R2：工具定义折叠（三段式）+ 系统提示段收纳（按需）
 * 落点：dsh-context-reclaim（ 集中化）
 *
 * ═══ 为什么落在 reclaim ═══
 *   工程决定：所有上下文改动只进两个插件（reclaim + aux-degrade）。
 *   reclaim 已有 llm/stream + tools/post-execute 钩子，是天然的"发送前拦截层"。
 *
 * ═══ R1 工具定义折叠 ═══
 *   依据（dsh-tool-folder@0.2.5 实测，注明 verified against DSH sources）：
 *     · assembly.tools is the ONLY source of the API request's tools
 *     · Execution is NOT gated on the current turn's tools —— folded tools
 *       still resolve through the full registry ⇒ **折叠不损失能力**
 *   三段式：core（全 schema）/ dyn（BM25 top-K）/ folded（丢 schema + 一行目录）
 *
 * ═══ R2 系统提示段收纳 ═══
 *   实测：系统提示 11,492 字符里 ~110 是内核贡献，其余 99% 是插件段
 *     （dsh-vault 6,525 = 57% · composer 目录 3,657 · lint/codegraph ~1,200）
 *   做法：按"段标题 → 归属插件"表，**未命中当前插件组合的段直接丢**
 *    零降智保障：丢的段可在"命令/工具描述"里按需查；且用开关可一键恢复
 * ══════════════════════════════════════════════════════════════════════════ */

/** R1/R2 开关（R1 默认开；R2 **默认关**，见 apply 里的 S1 说明）。
 *  开 R2：config.trimSections = true 或 DSH_RECLAIM_SECTION_TRIM=1；关 R1：DSH_RECLAIM_TOOL_FOLD=0。 */
const FOLD_ON = process.env.DSH_RECLAIM_TOOL_FOLD !== '0'
const SECTION_TRIM_ON = process.env.DSH_RECLAIM_SECTION_TRIM === '1'

/** dyn 段最多带几个工具的 schema（BM25 top-K）。 */
const FOLD_TOP_K = Number(process.env.DSH_RECLAIM_TOOL_FOLD_TOPK) > 0
  ? Number(process.env.DSH_RECLAIM_TOOL_FOLD_TOPK) : 12

/** 段标题 → 归属插件（未列出的段一律保留 —— 与 composer 同一纪律）。 */
const SECTION_OWNER = [
  [/^\s*##\s+Encrypted credential vault/i, 'dsh-vault'],
  [/^\s*##\s+CodeGraph Usage Rules/i, 'tool-codegraph'],
  [/^\s*#*\s*lint:\s/i, 'lint-loop'],
  [/^\s*##\s+Available plugins/i, 'dsh-capability-composer'],
  [/^\s*#\s*可用插件/i, 'dsh-capability-composer'],
]

/**
 * 极简分词：英文按非字母数字切，中文按**单字**切（与 dsh-tool-folder 同思路，
 * 因为中文没有空格；单字切分对 BM25 已足够区分工具名/描述）。
 */
function tokenizeForBm25 (text) {
  const out = []
  const s = String(text ?? '')
  for (const m of s.matchAll(/[A-Za-z0-9_]+|[\u4e00-\u9fff]/g)) out.push(m[0].toLowerCase())
  return out
}

/** 从会话消息里提取"当前意图"文本（最后一条 user 的纯文本）。 */
function currentIntent(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (m?.role !== 'user') continue
    const blocks = Array.isArray(m.content) ? m.content : []
    if (blocks.some((b) => b?.type === 'tool-result')) continue
    const text = blocks.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join(' ')
    if (text.trim().length > 0) return text
  }
  return ''
}

/** BM25（k1=1.2, b=0.75，照抄 dsh-tool-folder\lib\bm25.js 的标准参数）。 */
const BM25_K1 = 1.2
const BM25_B = 0.75

/**
 * BM25 打分（k1=1.2, b=0.75，照抄 dsh-tool-folder\lib\bm25.js 的标准参数）。
 * @param docs - '[{ text }]'。
 * @param query - 查询文本。
 * @returns '[{ i, score }]'：**只含 score > 0 的**，按分数降序（全序，不再截断）。
 */
function bm25Score (docs, query) {
  const tokenized = docs.map((d) => tokenizeForBm25(d.text))
  const avgdl = tokenized.reduce((a, t) => a + t.length, 0) / Math.max(1, tokenized.length)
  const df = new Map()
  for (const t of tokenized) for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1)
  const n = tokenized.length
  const qs = new Set(tokenizeForBm25(query))
  const scored = tokenized.map((toks, idx) => {
    const tf = new Map()
    for (const w of toks) tf.set(w, (tf.get(w) ?? 0) + 1)
    let acc = 0
    for (const w of qs) {
      const f = tf.get(w)
      if (!f) continue
      const idf = Math.log(1 + (n - (df.get(w) ?? 0) + 0.5) / ((df.get(w) ?? 0) + 0.5))
      acc += idf * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + (BM25_B * toks.length) / avgdl)))
    }
    return { i: idx, score: acc }
  })
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score)
}

/**
 * BM25 top-K（返回下标，行为与改造前逐位一致：只含正分、降序、截 K）。
 * @param docs - '[{ text }]'。
 * @param query - 查询文本。
 * @param topK - 取前几个。
 * @returns 下标数组。
 */
function bm25Rank (docs, query, topK) {
  return bm25Score(docs, query).slice(0, topK).map((s) => s.i)
}

/**
 * 把一份工具描述压成"一句话契约"（保留首句 + 硬约束句）。
 *  规则必须**确定性**（同一输入永远同一输出），否则破缓存。
 */
const HARD_SENT = /(must|never|do not|don't|cannot|only|required|mandatory|final|EPERM|denied|forbid|hard\b)/i

function shortToolDescription (desc) {
  const s = String(desc ?? '')
  if (s.length <= 200) return s
  /*   修：原来只按英文句末标点切（(?<=[.!?])\\s+）—— **对中文完全无效**
     （中文句号后面没有空格）⇒ 中文长描述被当成"一整句"整段保留 ⇒ **折叠等于没折**
     真机实测 30 个工具只从 18915 压到 18295（省 620 字符 ≈ 150 tok）。
     现在同时认中文句末标点（。！？；）与英文（.!?;）。这是"零降智"的：被折叠工具仍是"名字 + 一句契约"，
     执行不受 tools 数组限制（dsh-tool-folder 实测：assembly.tools 只是请求侧展示）。 */
  const parts = s.split(/(?<=[.!?。！？；;])\s*/).map((x) => x.trim()).filter(Boolean)
  const keep = [parts[0]]
  for (const p of parts.slice(1)) if (HARD_SENT.test(p) && keep.length < 4) keep.push(p)
  let out = keep.join(' ')
  if (out.length > 400) out = out.slice(0, 400) + ' …'
  else if (out.length < s.length) out += ' […]'
  return out
}

/** 短描述阈值（<= 此长度 ⇒ 压不动 ⇒ 留在 core）。 */
const CORE_DESC_MAX = 200

/** R12：上一帧入选 dyn 的工具名（滞后选择用，见 pickDynSticky 的注释）。 */
let lastDynNames = new Set()

/** R12：挑战者顶掉在位者所需的**超出比例**（0.2 = 要高 20% 才换；分数接近时不换）。 */
const STICKY_MARGIN = Number.isFinite(Number(process.env.DSH_RECLAIM_FOLD_STICKY))
  ? Math.max(0, Number(process.env.DSH_RECLAIM_FOLD_STICKY)) : 0.2

/** 工具名（两种包法都认）。 */
function toolNameOfDef (t) { return String(t?.function?.name ?? t?.name ?? '') }
/** 工具描述（两种包法都认）。 */
function toolDescOfDef (t) { return String(t?.function?.description ?? t?.description ?? '') }

/**
 * R12：**带滞后的 top-K**（照抄 'dsh-mcp@1.12.0' 的"未变化的工具保留原注册"思路）。
 *
 * 为什么要滞后：BM25 的 top-K 只由**当前意图**决定 ⇒ 意图里多一个词、或两个工具分数接近时，
 * dyn 集合就会在边界上反复换血 ⇒ tools 数组抖动 ⇒ **provider 前缀缓存频繁失效**
 * （工具定义是每请求都带的大头，抖动一次就要重算一大片）。
 *
 * 规则（两条，都可测）：
 *   ① **在位者优先**：上一帧入选、且本轮**仍有正分**的工具，按本轮分数降序先占位。
 *   ② **挑战者要赢得更多**：新晋者必须比"在位者里的最低分"高出 STICKY_MARGIN（默认 20%）
 *      才顶掉它 —— 分数接近时**不换**，这就是滞后。
 *    上一帧入选、但本轮**分数为 0**（意图完全无关）的工具**不保留** —— 滞后不是"粘住不动"。
 *
 * 确定性：同一 (scored, topK, lastDynNames) 永远给同一结果；测试可用 __resetFoldState 复位。
 * @param scored - bm25Score 的结果（'[{ i, name, score }]'，已降序）。
 * @param topK - 容量。
 * @returns 入选工具名的 Set。
 */
function pickDynSticky (scored, topK) {
  const picked = new Set()
  if (topK <= 0 || !Array.isArray(scored) || scored.length === 0) return picked
  for (const s of scored) {
    if (picked.size >= topK) break
    if (lastDynNames.has(s.name)) picked.add(s.name)
  }
  for (const s of scored) {
    if (picked.has(s.name)) continue
    if (picked.size < topK) { picked.add(s.name); continue }
    let weakestName = null
    let weakestScore = Infinity
    for (const s2 of scored) {
      if (!picked.has(s2.name)) continue
      if (s2.score < weakestScore) { weakestScore = s2.score; weakestName = s2.name }
    }
    if (weakestName === null) break
    if (shouldReplace(weakestScore, s.score)) {
      picked.delete(weakestName)
      picked.add(s.name)
    }
  }
  return picked
}

/**
 * R12 滞后判据（抽成纯函数 ⇒ 可被门禁直接证伪）：挑战者要**比在位者高出 STICKY_MARGIN** 才换。
 * @param inPlaceScore - 在位者的分数。
 * @param challengerScore - 挑战者的分数。
 * @returns 是否替换。
 */
function shouldReplace (inPlaceScore, challengerScore) {
  return challengerScore > inPlaceScore * (1 + STICKY_MARGIN)
}

/** 测试用：复位 R12 的粘滞状态。 */
function resetFoldState () { lastDynNames = new Set() }

/**
 *  R1：工具面三段式折叠（R12 加入顺序稳定化）。
 * @param {object} assembly - system-prompt/assemble 的 assembly（含 tools）。
 * @param {string} intent - 当前意图文本（用于 BM25）。
 * @returns 新的 assembly（原对象不改）。
 */
function foldToolSurface (assembly, intent) {
  if (!FOLD_ON) return assembly
  const tools = Array.isArray(assembly?.tools) ? assembly.tools : null
  if (tools === null || tools.length === 0) return assembly
  /* core：描述本身很短（<=CORE_DESC_MAX）⇒ 压不了多少 ⇒ 保持全 schema。
     dyn：BM25 top-K（query = 当前意图 + 粘滞）。folded：其余 ⇒ 只留"名字 + 一句契约"。 */
  const dynCand = tools.filter((t) => toolDescOfDef(t).length > CORE_DESC_MAX)
  const docs = dynCand.map((t) => ({ text: toolNameOfDef(t) + ' ' + toolDescOfDef(t), tool: t }))
  /*  取全序（不截断），滞后选择在 pickDynSticky 里做。 */
  const scored = intent.trim().length > 0
    ? bm25Score(docs, intent).map((s) => ({ ...s, name: toolNameOfDef(dynCand[s.i]) }))
    : []
  const dynNames = pickDynSticky(scored, FOLD_TOP_K)
  lastDynNames = new Set(dynNames)
  /*  R12：**输出顺序 = 原始工具数组顺序**（原先是 [...core, ...dyn, ...folded] 三组重排）。
     重排会让"同一个工具集的两种呈现"产生不同的 tools 数组 ⇒ 无谓破缓存；
     保持原序后，只有"某个工具的呈现变了"才改变数组内容，顺序维度恒稳定。 */
  const out = tools.map((t) => {
    if (toolDescOfDef(t).length <= CORE_DESC_MAX) return t
    if (dynNames.has(toolNameOfDef(t))) return t
    const name = toolNameOfDef(t)
    const desc = toolDescOfDef(t)
    const params = t?.function?.parameters ?? t?.parameters
    const slimmed = (params && typeof params === 'object') ? slimSchema(params) : params
    /*  形态保持（ 真机取证后的修复）——**必须与生产数组里其它元素同形**。
       现场证据（[reclaim/tool-fold] 形状取证）：
         · 真机 assembly.tools 是**裸形**：「name + description + parameters」（没有 function 包装）
         · 旧实现却把 folded 条目自己包成「{type:function, function:{…}}」
       ⇒ 数组变成**混合形状** ⇒ 宿主按裸形规范再包一层 ⇒ provider 反序列化直接拒收
         （实测报错：'tools[1].function: missing field name'）⇒ 整个请求失败。
       做法：**原样展开、只改 description/parameters** ⇒ 形状与其余字段（strict 等）都不变。
        只在"部分工具被折叠"时才暴露（全折叠时形状一致、看不出问题）—— 所以必须保持同形。 */
    if (t !== null && typeof t === 'object' && t.function !== undefined) {
      return { ...t, function: { ...t.function, name, description: shortToolDescription(desc), parameters: slimmed } }
    }
    return { ...t, name, description: shortToolDescription(desc), parameters: slimmed }
  })
  /*  形状守卫：折叠产物必须**每一项都带 name**。
     实测形状（provider 侧反序列化错误）：'tools[1].function: missing field name' ——
     一旦有这种条目，整个请求会被直接拒掉（比"多花 token"糟糕得多）。
     ⇒ 宁可**放弃折叠**（返回原 assembly），也绝不发出畸形工具面。 */
  const badIdx = []
  for (let i = 0; i < out.length; i += 1) {
    const fn = out[i] === null || typeof out[i] !== 'object' ? undefined : out[i].function
    const nm = fn === undefined ? out[i]?.name : fn.name
    if (typeof nm !== 'string' || nm.length === 0) badIdx.push(i)
  }
  if (badIdx.length > 0) {
    try {
      console.error('[reclaim/tool-fold] ⚠️ 折叠产物有 ' + badIdx.length + ' 个工具缺 name（下标 '
        + badIdx.join(',') + '）⇒ 放弃折叠、返回原工具面（防 provider 拒收）')
    } catch { /* ignore */ }
    return assembly
  }
  /*  形状取证（只打一次）：把真机的工具形状记下来 —— 形状问题只能靠实证，不能靠猜。 */
  if (!foldShapeLogged) {
    foldShapeLogged = true
    try {
      const brief = (x, i) => i + ':' + Object.keys(x ?? {}).join('+') + '→'
        + Object.keys(x?.function ?? {}).join('+') + '·' + String(x?.function?.name ?? x?.name ?? '-')
      console.error('[reclaim/tool-fold] 工具面形状（前 3 项，in→out）：'
        + tools.slice(0, 3).map(brief).join(' | ') + ' ‖ ' + out.slice(0, 3).map(brief).join(' | '))
    } catch { /* ignore */ }
  }
  /*  R14：对**全部**工具做一次参数说明精简（原来只有 folded 那类被 slimSchema 处理过）。
     形态保持由 foldParamDescriptions 负责（裸形进裸形出）。 */
  const trimmed = PARAM_DESC_ON ? out.map((t) => foldParamDescriptions(t)) : out
  /*  R19：给"整篇重写"类工具的 description 插"优先用 edit"提示（最强的一条）。 */
  return { ...assembly, tools: hintRewriteTools(trimmed) }
}

/** 形状取证只打一次（避免每请求刷屏）。 */
let foldShapeLogged = false

/** 入口探针只打一次（定位"钩子进了、改写块没进"的原因）。 */
let wireProbeLogged = false

/** 配对探针只打一次（定位"改写前就已缺失 tool 结果"这种非本插件造成的情况）。 */
let pairProbeLogged = false

/** 只剪 schema 里的 description 文本（**不删任何键** ⇒ required ⊆ properties 恒成立）。 */
/**  R14：参数说明精简。
 *
 * 为什么：量了生产 tools 数组 —— 18,203 字符里 **parameters 占 10,992（60%）**、
 *   description 只占 5,657（31%）⇒ R1 之前**只压 description，60% 那块从没碰过**。
 * 做法：参数级 description 超过阈值的**只留第一句**（按中英文句号/分号切句，不硬切字符串），
 *   ≤ 阈值的一字不动（短说明是必要信息，不是啰嗦）。
 * 缓存代价：工具定义在请求最前面 ⇒ 改它破一次前缀；但规则确定、每帧结果一致 ⇒ **只破第一次**，
 *   之后照旧命中 ⇒ 净赚（不是每帧都破）。
 * 关掉：DSH_RECLAIM_PARAM_DESC=0；阈值：DSH_RECLAIM_PARAM_DESC_MAX（默认 80）。
 */
const PARAM_DESC_ON = process.env.DSH_RECLAIM_PARAM_DESC !== '0'
const PARAM_DESC_MAX = intEnv('DSH_RECLAIM_PARAM_DESC_MAX', 80)


/**
 *  R14：把一个参数的说明压成"第一句"（只在超过阈值时才动）。
 * @param t - 说明原文。
 * @param max - 阈值。
 * @returns 压短后的说明。
 */
function shortParamText (t, max = PARAM_DESC_MAX) {
  const str = String(t ?? '')
  if (str.length <= max) return str
  const parts = str.split(/(?<=[.!?。！？；;])\s*/)
  let out = parts[0] ?? str.slice(0, max)
  const cap = max * 2
  if (out.length > cap) out = out.slice(0, cap)
  return out
}

/**
 * R14：精简一个工具的**参数说明**（形态保持：裸形进裸形出、包形进包形出）。
 * @param tool - 工具定义。
 * @returns 精简后的工具定义（无变化则原样返回）。
 */
function foldParamDescriptions (tool) {
  if (tool === null || typeof tool !== 'object') return tool
  const src = tool.function !== undefined ? tool.function : tool
  const params = src?.parameters
  if (params === null || params === undefined || typeof params !== 'object') return tool
  const nextParams = slimSchema(params, PARAM_DESC_MAX)
  if (JSON.stringify(nextParams) === JSON.stringify(params)) return tool
  return tool.function !== undefined
    ? { ...tool, function: { ...tool.function, parameters: nextParams } }
    : { ...tool, parameters: nextParams }
}

function slimSchema (schema, maxDesc = 60) {
  if (schema === null || typeof schema !== 'object') return schema
  if (Array.isArray(schema)) return schema.map((x) => slimSchema(x, maxDesc))
  const out = {}
  for (const [k, v] of Object.entries(schema)) {
    /*  R14：以前是硬截断（v.slice(0, maxDesc) + ' …'）—— 会截在句子中间，读起来像断掉的指令。
       改成"保留第一句"：信息完整性更好，省得也一样多。 */
    if (k === 'description' && typeof v === 'string' && v.length > maxDesc) out[k] = shortParamText(v, maxDesc)
    else out[k] = (v && typeof v === 'object') ? slimSchema(v, maxDesc) : v
  }
  return out
}

/**
 *  R2：系统提示段收纳。
 * @param {object} assembly - 含 sections（每段有 text/title）。
 * @param {string[]} activePlugins - 当前组合里的插件 id（小写）。
 * @returns 新的 assembly（原对象不改）。
 */
/**  R15（ 实测新增）：系统提示长描述行截断。
 *
 * 实测（真机会话）：系统提示 11,620 字符里，"目录/说明型"内容约占 3,400 字符 ——
 *   插件目录（composer 注入 ~1,925）+ 凭据库说明（dsh-vault ~1,300）+ 评审插件说明（145），
 *   其中大量是**每行 128-340 字符的描述**（一串串英文长句）。
 * 做法：>PROMPT_LINE_MAX 字符的**描述型**长行截到"第一句"（复用 shortParamText，不硬切句子）。
 *  **指令行一律不动**：Use… / Do not… / Never… / You must… / 必须… / 绝不… ——
 *   它们直接决定模型行为，删了就是降智（这是本项和"砍系统提示"之间的红线）。
 * 缓存代价：系统提示在请求最前面 ⇒ 破一次前缀；规则确定、每帧一致 ⇒ **只破第一次**。
 * 关掉：DSH_RECLAIM_PROMPT_LINE=0；阈值：DSH_RECLAIM_PROMPT_LINE_MAX（默认 120）。
 */
const PROMPT_LINE_ON = process.env.DSH_RECLAIM_PROMPT_LINE !== '0'
const PROMPT_LINE_MAX = intEnv('DSH_RECLAIM_PROMPT_LINE_MAX', 120)
/*   修正（实测误伤）：列表项里的指令（"- DO NOT trust…"、"- Workflow: ALWAYS check…"）
   会被"以 - 开头"绕过保护 ⇒ 判定前先剥掉列表/引用前缀，并且**大小写不敏感**（DO NOT / Do not 都要保护）。
   注意：\b 不能用来卡 "Do not"（"dot" 也会命中），所以用词边界空格。 */
const INSTRUCTION_LINE_RE = /(^|\s)(use|do not|don't|never|always|must|should|need|when you|if you|note:|important:|必须|绝不|禁止|一定|不要|务必|注意)/i
const LIST_PREFIX_RE = /^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*)+/

/* ═══════════════════════════════════════════════════════════════════════════
 *  R18：输出纪律注入 —— 唯一能"降低每步增量"且不破前缀的手段。
 *
 * ── 实测（为什么需要它）──────────────────────────────────────────────────────
 *   Reasonix 实测每帧增量中位 **696~1,078 tok**（6 个会话段：841 / 730 / 696 / 1,076 / 1,078）；
 *   本插件（实测 132 步会话）**1,398 tok/步** ⇒ **高 66%**。
 *   差在哪：Reasonix 每帧的 out 只有 **91~677 tok**（明细：109/240/149/312/103/677/301/91/138…），
 *   而写代码时单次输出上千 —— **它涨得慢，是因为它的模型"话少"，不是有隐藏机制。**
 *  （630 包与 Reasonix 都只有"到 80% 压一次"：argp windowRatio 0.8/retainRatio 0.2、
 *    reasonix compact_ratio 0.8/context_window 1000000 ⇒ 平时该涨就涨。）
 *
 * ── 做法 ─────────────────────────────────────────────────────────────────────
 *   追加一段"输出纪律"到 system-prompt 的**末尾**（末尾追加 **不破坏前缀缓存**）。
 *   只约束**冗余**，不动实质内容：不复述已写过的代码、不重复读同一文件、不逐条重述日志。
 *   关掉：DSH_RECLAIM_OUTPUT_DISCIPLINE=0。
 * ═══════════════════════════════════════════════════════════════════════════ */

const OUTPUT_DISCIPLINE_ON = process.env.DSH_RECLAIM_OUTPUT_DISCIPLINE !== '0'
const OUTPUT_DISCIPLINE_TEXT = [
  '## 上下文预算纪律（降低上下文增长，请严格遵守）',
  '',
  '- **不要复述已经写过的代码**：改完后只说明"改了哪个文件、哪几处、为什么"，不要贴整段源码。',
  '- **不要重复读同一个文件**：本会话已经读过的文件，直接引用其内容，必要时只读需要的区间（offset/limit）。',
  '- **不要逐条重述命令输出**：日志/列表类结果只写结论与关键几行（错误行、统计行）。',
  '- **连续的工具调用合并成一批**：能一次做完的探测不要拆成多次往返。',
  '- **结论优先**：先给结论，再给必要的证据；不复述用户已经知道的信息。',
  '- **write is for creating new files only.** To change an existing file — however many parts you touch — ' +
  'use edit; it sends only the replaced lines while write re-sends the whole body.',
  '',
  '（这条纪律只约束冗余表述，不限制必要的信息量与代码质量。）'
].join('\n')

/* ═══════════════════════════════════════════════════════════════════════════
 *  R20：预算观测（**observe-only：只记录、绝不拦截**）。
 *
 * ── 为什么先观测不拦截 ───────────────────────────────────────────────────────
 * 生态里有 20 个包做"每轮步数/工具调用数硬上限"（'dsh-turn-budget' 默认 24 步 / 40 次工具），
 * 那是**防失控烧钱**用的，不是"让上下文长得慢"。实测一个体检任务用了 **93 次工具调用**，
 * 若按 40 硬拦 ⇒ **任务做不完 / 模型偷工**（少读少验）⇒ **质量硬伤**。
 * ⇒ 所以本项**只观测**：记录每轮的步数、工具调用数、同一文件的改动次数，先拿真实分布。
 * 关掉：DSH_RECLAIM_BUDGET_OBSERVE=0。
 *
 * ── R21 软提醒（同文件反复重写才提示，不拦）──────────────────────────────────
 * 触发条件：**同一个文件在近 BUDGET_CHURN_WINDOW 次工具调用内被 edit/write 超过 BUDGET_CHURN_MAX 次**。
 * 那几乎总是"模型在反复重写同一段代码"（真实问题是它没想清楚），而不是任务需要。
 * 做法：**把一句固定的提示追加到 system prompt 末尾**（只在"进入触发态"时加一次，之后文本不变 ⇒ 最多破一次前缀）。
 * 关掉：DSH_RECLAIM_BUDGET_NUDGE=0。
 * ═══════════════════════════════════════════════════════════════════════════ */

const BUDGET_OBSERVE_ON = process.env.DSH_RECLAIM_BUDGET_OBSERVE !== '0'
/**
 *：**默认改为关**（原来 `!== '0'` 是"不设就开"）。
 *
 * 为什么改默认值：当前机器一直是靠"设 `DSH_RECLAIM_BUDGET_NUDGE=0` 环境变量"来关它的；
 * 但**新装一台机器不会设这个变量** ⇒ nudge 默认生效 ⇒ 它会**删掉 system prompt 里的一段
 * 再重写** ⇒ **前缀从那里起全废**（实测新机器报告里的症状就是这个）。
 *
 * 原则：**破前缀的功能，默认必须关**。想用的人显式 `=1` 打开。
 * 打开：`DSH_RECLAIM_BUDGET_NUDGE=1`。
 */
const BUDGET_NUDGE_ON = process.env.DSH_RECLAIM_BUDGET_NUDGE === '1'
const BUDGET_CHURN_MAX = intEnv('DSH_RECLAIM_CHURN_MAX', 3)
const BUDGET_CHURN_WINDOW = intEnv('DSH_RECLAIM_CHURN_WINDOW', 30)
const BUDGET_REPORT_EVERY = intEnv('DSH_RECLAIM_BUDGET_REPORT', 20)

const budgetState = {
  calls: 0,            /* 本会话当前轮累计工具调用 */
  turns: 0,            /* 轮次 */
  fileEdits: new Map(),/* 文件 → 最近改动时的调用序号数组 */
  nudgeActive: false,  /* 是否已进入"该提示"的状态（进入才注入，避免每步都变） */
  lastReport: 0
}

/*  R28：**错误假设污染检测** —— 只记账 + 打一行警告，不改任何东西。
 *
 * 依据 context-degradation 的三节：
 *   · Context Poisoning（预防与恢复）：错误结论留在上下文里会持续污染后续推理；
 *   · Context Confusion（任务隔离）：不相关/错误的线索混在一起会让 Agent 失去焦点；
 *   · The Four-Bucket Mitigation Framework。
 *
 * 真机教训（ 本会话）：修"技能面板点组合进去空白"连改三次都没对 ——
 * 第一次以为 slot 没注册，第二次以为 require 跨 bundle 不通，第三次才发现是
 * modelInvocable 的自遮蔽死循环。**前两次的错误结论一直留在上下文里**，每次
 * 都在它们之上继续推理。这正是 Context Poisoning 的教科书案例。
 *
 * 判据：**同一个目标连续失败达到 POLLUTION_MIN 次**（目标 = 被编辑的文件路径；
 * 拿不到路径的（命令类）退化用工具名）。成功一次即清零 —— 成功说明当前思路对了。
 *
 * 为什么是"无损"：不打补丁、不改消息、不清历史，**只在 console.error 里留一行**
 * （给人看，不花模型 token），提示"该重述已知事实而不是继续在旧假设上叠加"。
 *
 * 关掉：DSH_RECLAIM_POLLUTION=0。阈值：DSH_RECLAIM_POLLUTION_MIN（默认 3）。
 */
const POLLUTION_ON = process.env.DSH_RECLAIM_POLLUTION !== "0"
const POLLUTION_MIN = intEnv("DSH_RECLAIM_POLLUTION_MIN", 3)
const POLLUTION_WINDOW = intEnv("DSH_RECLAIM_POLLUTION_WINDOW", 40)
const pollutionState = {
  fails: new Map(),  /* 目标 → 失败时的调用序号数组 */
  warned: new Set(), /* 已警告过的目标（只警告一次，避免刷屏） */
}

/**
 * R28：记一次工具结果，失败时累加、成功时清零；连续失败到阈值就警示。
 * @param exec - 工具执行上下文（含 name 与 arguments）。
 * @param result - 工具结果（isError === true 表示失败）。
 * @returns 无。
 */
function noteToolFailure (exec, result) {
  if (!POLLUTION_ON) return
  /* 目标：优先用"被操作的文件路径"（同一文件反复失败最典型）；
     拿不到路径（pwsh 等命令类）时退化成"工具名" —— 同一命令反复失败同样值得警告。 */
  let key = ""
  try {
    const a = typeof exec?.arguments === "string" ? JSON.parse(exec.arguments) : (exec?.arguments ?? {})
    key = String(a?.file_path ?? a?.path ?? a?.filePath ?? "")
  } catch { /* 参数不是 JSON ⇒ 退化 */ }
  if (key.length === 0) key = String(exec?.name ?? exec?.toolName ?? "")
  if (key.length === 0) return
  const failed = result !== null && typeof result === "object" && result.isError === true
  if (!failed) {
    /* 成功 ⇒ 清零并允许以后再次警告（说明"当前思路是对的"）。 */
    pollutionState.fails.delete(key)
    pollutionState.warned.delete(key)
    return
  }
  const arr = pollutionState.fails.get(key) ?? []
  arr.push(budgetState.calls)
  /* 只留窗口内的，防无界增长。 */
  while (arr.length > 0 && budgetState.calls - arr[0] > POLLUTION_WINDOW) arr.shift()
  pollutionState.fails.set(key, arr)
  if (arr.length >= POLLUTION_MIN && !pollutionState.warned.has(key)) {
    pollutionState.warned.add(key)
    try {
      console.error("[reclaim/pollution] ⚠️ 目标「" + key + "」在近 " + POLLUTION_WINDOW
        + " 次工具调用里连续失败 " + arr.length + " 次 ⇒ 大概率是**前几次的错误结论还在污染推理**。"
        + "建议：先重述「当前已确认的事实」（改了什么、观察到什么、哪条假设已被推翻），"
        + "再决定下一步 —— 不要在旧假设上继续叠加。")
    } catch { /* ignore */ }
  }
}

/**
 * R20：记录一次工具调用（**绝不拦截**，只累加统计）。
 * @param name - 工具名。
 * @param args - 工具参数（字符串或对象）。
 * @returns 无。
 */
function noteToolCall (name, args) {
  if (!BUDGET_OBSERVE_ON) return
  budgetState.calls += 1
  const nm = String(name ?? '')
  if (!/^(write|write_file|create_file|save_file|overwrite_file|edit|edit_file|str_replace|apply_patch|multi_edit)$/.test(nm)) return
  let fp = ''
  try {
    const o = typeof args === 'string' ? JSON.parse(args) : args
    fp = String(o?.file_path ?? o?.path ?? o?.filePath ?? '')
  } catch { return }
  if (fp.length === 0) return
  const arr = budgetState.fileEdits.get(fp) ?? []
  arr.push(budgetState.calls)
  /* 只留窗口内的，防无界增长。 */
  while (arr.length > 0 && budgetState.calls - arr[0] > BUDGET_CHURN_WINDOW) arr.shift()
  budgetState.fileEdits.set(fp, arr)
  if (arr.length > BUDGET_CHURN_MAX && !budgetState.nudgeActive) {
    budgetState.nudgeActive = true
    try {
      console.error('[reclaim/budget-nudge] ⚠️ 同一文件在近 ' + BUDGET_CHURN_WINDOW + ' 次工具调用里被改了 '
        + arr.length + ' 次：' + fp + ' ⇒ 建议改用 edit 精准替换，或先想清楚再改')
    } catch { /* ignore */ }
  }
}

/*  R22提出"只拦重复就无损"）：拦截【完全相同的重复编辑】。
 *
 * 依据：'tools/pre-execute' 的拒绝签名是 'return { kind: 'deny', reason: '…' }'
 *   （见 <APP_ROOT>\node_modules\@deepseek-ai\dsh-hooks-claude-code\lib\index.js
 *   的 PreToolUse 处理）。此前只观测（R20）和软提醒（R21），现在加**真正的拦截**。
 *
 * 为什么"拦完全相同的编辑"是**无损**的：
 *   同一个 file_path + 逐字节相同的 old_string/new_string/content ⇒ **结果必然一模一样**
 *   ⇒ 拦掉它不改变任何结果，只省一次往返和一份重复的工具参数/结果。
 *   （即使上次失败，用**同样参数**重试也必然再失败 ⇒ 拦掉不亏。）
 *
 *  只拦文件编辑（write/edit 类），**不拦 pwsh 等命令类** —— 命令重复执行常见且合法
 *   （轮询、等待、重跑测试）。命令类交给 R20 的观测和 R21 的软提醒。
 * 关掉：DSH_RECLAIM_DEDUP_DENY=0。
 */
const DEDUP_DENY_ON = process.env.DSH_RECLAIM_DEDUP_DENY !== '0'
const EDIT_TOOL_FOR_DEDUP = /^(write|write_file|create_file|save_file|overwrite_file|edit|edit_file|str_replace|apply_patch|multi_edit)$/
const dedupSeen = new Map()

/**
 * R22：判定并记录一次编辑调用；返回拒绝对象或 null。
 * @param name - 工具名。
 * @param args - 工具参数（字符串或对象）。
 * @returns 拒绝对象（含 kind 与 reason 两个字段）或 null（放行）。
 *    这里不写 TypeScript 风格的对象类型注解 —— G-15 的 no-undef 会把
 *   'kind:deny' 这种写法里的 kind 当成代码标识符，误报为未声明。
 */
function checkDuplicateEdit (name, args) {
  if (!DEDUP_DENY_ON) return null
  const nm = String(name ?? '')
  if (!EDIT_TOOL_FOR_DEDUP.test(nm)) return null
  let key = ''
  try {
    const o = typeof args === 'string' ? JSON.parse(args) : args
    const fp = String(o?.file_path ?? o?.path ?? o?.filePath ?? '')
    /* 逐字节比较**全部参数**（排序后序列化 ⇒ 字段顺序无关）。 */
    const body = JSON.stringify(o, Object.keys(o ?? {}).sort())
    key = nm + '|' + fp + '|' + body
  } catch { return null }
  if (key.length === 0) return null
  if (dedupSeen.has(key)) {
    try {
      console.error('[reclaim/dedup-deny] ⛔ 拦掉【完全相同的重复编辑】：' + nm + '（' + key.split('|')[1] + '）'
        + ' —— 参数与上次逐字节相同，结果必然一样，白花一次往返')
    } catch { /* ignore */ }
    return { kind: 'deny', reason: 'dsh-context-reclaim: identical edit already applied in this session (same file, byte-identical arguments). Do not repeat it; inspect the file or change your approach.' }
  }
  dedupSeen.set(key, true)
  return null
}

/** R20：轮末汇总（每 BUDGET_REPORT_EVERY 次调用打一次，避免刷屏）。 */
function maybeReportBudget (routeKey) {
  if (!BUDGET_OBSERVE_ON) return
  if (budgetState.calls - budgetState.lastReport < BUDGET_REPORT_EVERY) return
  budgetState.lastReport = budgetState.calls
  try {
    const hot = [...budgetState.fileEdits.entries()].filter(([, a]) => a.length >= 2).sort((x, y) => y[1].length - x[1].length).slice(0, 3)
      .map(([f, a]) => f.split('\\').pop() + '×' + a.length).join(' ')
    console.error('[reclaim/budget-observe] route=' + routeKey + ' 本轮工具调用 ' + budgetState.calls
      + ' 次 · 被改过的文件 ' + budgetState.fileEdits.size + ' 个'
      + (hot.length > 0 ? ' · 改得最多的：' + hot : '') + '（observe-only，不拦截）')
  } catch { /* ignore */ }
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  R17：注入去重 —— 删掉"内容已经在对话历史里"的注入行。
 *
 * ── 实测（真机会话，拆 Current runtime context 快照 1,019 字符）─────────────
 *   第 1 行  84 字符  Current runtime context. This snapshot supersedes...
 *   第 3 行 127 字符  Current DSH file policy: danger-full-access...
 *   第 5 行 175 字符  Approval prompts are disabled in this session...
 *   第 7 行   8 字符  【灵枢最近记忆】                       ← @furongjun1999/dsh-memory 注入
 *   第 8~11 行 **615 字符（60%）**  "- [contextual] <用户消息原文>"  ← **与对话历史逐字重复**
 * ⇒ 那 615 字符是"把早先说过的话又贴一遍"，而同样的消息**本来就在 messages 里** ⇒ 纯浪费。
 *   （一个 143 事件的会话里有 2 份快照 ⇒ 约 342 tok 白费。）
 *
 * ── 做法与无损性 ─────────────────────────────────────────────────────────────
 *   逐行判断：只删**内容确实在 messages 里能找到**的注入行（默认针对 "- [contextual] …" 形状）。
 *   ⇒ 跨会话的记忆（历史里没有的）**一律保留** ⇒ 不丢任何信息。
 *   ⇒ 模型照样能看到那些消息 —— 因为它们就在对话历史里。
 *   开关：DSH_RECLAIM_INJECT_DEDUPE=0 关；阈值：DSH_RECLAIM_INJECT_MIN_CHARS（默认 24）。
 * ═══════════════════════════════════════════════════════════════════════════ */

/* ===========================================================================
 * R23：抹平系统提示里的「易变数字」—— 真机定位到的破前缀主因。
 *
 * 证据（真机 diff 两份 system prompt）：
 *   行 74：A = 未归属工具 misc · 11 个工具   B = 同处 · 12 个工具
 *   行 76：A = 空行                           B = mcp:vnpy · 213 个工具
 *   前缀只共享到 9,080 字符，从第 74 行起 22 行全部作废。
 *   cache-break 原因分布（最近 6 万行）：system+prefix 104 次 居首
 *   （first-seen 73 · prefix+wire 17 · wire 10 · system+tools+prefix 4）。
 *
 * 为什么数字会变：composer 注入的「插件目录」段写着「N 个工具」，
 *   N 随 load_plugin / MCP 服务器的出现与消失而变 ⇒ 整段文本变 ⇒ 破前缀。
 *   而「某插件有几个工具」对模型毫无用处（它要的是插件名与用途）。
 *
 * 做法：把目录段里的「N 个工具」/「· N 个」归一化成固定文本 ⇒ 每帧一致 ⇒ 前缀稳定。
 *   只动数字，不动名字与用途 —— 模型需要的信息一个不少。
 * 关掉：DSH_RECLAIM_STABILIZE=0。
 * ===========================================================================

/**
 * R23：抹平一段文本里的易变数字（只针对工具/条目计数）。
 *   正则内联在函数里（不放模块顶层常量）—— 真机上曾出现顶层 const 取不到的问题，
 *   内联可彻底规避任何 TDZ / 作用域边界。
 * @param text - 原文。
 * @returns 归一化后的文本。
 */
function stabilizeCounts (text) {
  return String(text ?? '')
    .replace(/\d+\s*个工具/g, '若干工具')
    .replace(/·\s*\d+\s*个(?![工具])/g, '· 若干')
}

/** R23 的开关（放在函数之后，避免顶层 const 的取用顺序问题）。 */
function stabilizeEnabled () { return process.env.DSH_RECLAIM_STABILIZE !== '0' }

/**
 * R23：对 assembly 的 sections 做数字归一化。
 * @param assembly - 含 sections 的 assembly。
 * @returns 新的 assembly（原对象不改）。
 */
function stabilizePromptCounts (assembly) {
  if (!stabilizeEnabled()) return assembly
  const sections = Array.isArray(assembly?.sections) ? assembly.sections : null
  if (sections === null || sections.length === 0) return assembly
  let changed = false
  const next = sections.map((sec) => {
    const t = String(sec?.text ?? '')
    if (t.length === 0) return sec
    const s2 = stabilizeCounts(t)
    if (s2 === t) return sec
    changed = true
    return sec.text !== undefined ? { ...sec, text: s2 } : { ...sec, content: s2 }
  })
  return changed ? { ...assembly, sections: next } : assembly
}
/* ===========================================================================
 * R24：把**易变段后置** —— 真机定位到的第二个破前缀主因。
 *
 * 证据（125 份真机 system prompt 的逐行出现率统计）：
 *   有一整片段落（约 25+ 行）出现率都是 **78%** —— 也就是 22% 的时候它们不在：
 *     - Encrypted credential vault (dsh-vault)
 *     - 可用插件（插件目录）· 代码评审（dsh-review-squad）
 *     - CodeGraph Usage Rules · AgentTeams captain protocol · context7 工具说明
 *   这些段一旦消失/出现，**整段位移** ⇒ 从该处起全部作废（实测某段独占 10,144 字符）。
 *   而 cache-break 里 **system+prefix 104 次居首**、且 **prefixLen 只有 8** ⇒
 *   说明"公共前缀极短"，即请求开头就不同 —— 正是这些段的出现/消失导致的位移。
 *
 * 做法：重排 sections 的 order —— **稳定段在前、易变段在后**
 *   · 易变判据：段文本含插件注入类关键词（credential vault / 可用插件 / 评审 /
 *     AgentTeams / context7 / codegraph 等）⇒ 给一个大 order 排到最后；
 *   · 其余段保持原有相对顺序。
 *    只调 order，不改任何文本 —— 模型看到的内容一个不少，只是顺序更稳。
 * 缓存代价：重排会让前缀**破一次**，之后（只要段的"存在性"不反复变）就稳定。
 * 关掉：DSH_RECLAIM_ORDER=0。
 * ===========================================================================

/*：改「按名字猜」为「按行为判」—— 删掉硬编码关键词表。
 *
 * ── 旧做法的毛病（为什么必须改）─────────────────────────────────────────────
 * 旧判据是「段名 或 段文前 400 字符命中一张关键词表（credential vault / 可用插件 /
 * codegraph / context7 …）」⇒ 才判为易变段。
 *    **硬编码**：新装一个插件，它的段名/正文不在表里 ⇒ 被当成"稳定段"排在前面
 *      ⇒ 它一变就破前缀。**这就是"以后装任何新插件都可能复发"的根。**
 *
 * ── 新做法：只看行为 ───────────────────────────────────────────────────────
 *   · 每个段名维护「内容哈希 + 连续不变次数」；
 *   · **首次见到的段 ⇒ 保守判易变**（还没证明它稳定，先不让它占前缀）；
 *   · **连续 SEG_STABLE_AFTER 次内容不变 ⇒ 转为稳定**（可以排前面了）；
 *   · **一旦内容又变 ⇒ 立刻回到易变**。
 * ⇒ 不依赖任何关键词、任何插件名；装什么新插件都能自适。
 *
 * ── 为什么必须"双向"，不能"变过就永久标记"────────────────────────────────
 * 段的稳定性会**变**：插件目录段常在新会话初期抖、之后固定；知识库段反之。
 * 只单向标记的话，前者永远排后面（浪费前缀位置），后者永远排前面（继续破前缀）。
 *
 * ── 代价 ───────────────────────────────────────────────────────────────────
 * 段从"易变"转"稳定"时顺序会变 ⇒ 破一次前缀。这是**故意付的**
 * 换来之后长期的稳定顺序。SEG_STABLE_AFTER=3 是"少付几次"与"快点转正"的折中。
 */
const SEG_STABLE_AFTER = 3
/** 段名的稳定性记录：段名 -> { hash, sameCount, volatile }。 */
const segStability = new Map()

/**
 * 按**行为**判定一个段是否易变（取代原来的关键词匹配）。
 * @param name - 段名。
 * @param text - 段文本。
 * @returns {boolean} 是否易变（true = 应排到后面）。
 */
function isVolatileSegByBehavior (name, text) {
  const h = shapeHash(String(text ?? ''))
  const rec = segStability.get(name)
  if (rec === undefined) {
    /* 首见 ⇒ 保守判易变。 */
    segStability.set(name, { hash: h, sameCount: 0, volatile: true })
    return true
  }
  if (rec.hash === h) {
    rec.sameCount += 1
    if (rec.sameCount >= SEG_STABLE_AFTER) rec.volatile = false
  } else {
    rec.hash = h
    rec.sameCount = 0
    rec.volatile = true
  }
  return rec.volatile
}
/**
 *   起：段身份的判定缓存（段名 -> 是否易变）。
 *
 * 真机证据（dump 两份 system prompt 逐行 diff，会话 08d10c82）：
 *   第 168 行  A = 「- semgrep-sast · …」
 *              B = 「  · ralph — Run a foreground fresh-agent Ralph loop…」  ← 凭空多一行
 *   ⇒ 插件目录段少/多一行 ⇒ 其后 60+ 行整体位移 ⇒ system 全变 ⇒ 前缀断。
 *   ⇒ 日志同样显示「段重排：稳定 28 段」与「稳定 29 段」来回跳。
 *
 *  的第一版修法：判定只认段名 + 首判粘住。
 *   的第二版修法（当前）：**彻底删掉关键词表，改按行为判定** ——
 *   因为"只认段名 + 首判用关键词表"仍然是**硬编码**：新装插件的段不在表里 ⇒
 *   被当稳定段 ⇒ 一变就破前缀（等于"以后装任何新插件都可能复发"）。
 *   现在见 `isVolatileSegByBehavior()`：只看内容**是否真的在变**。
 */

/**
 * R24：把易变段排到 sections 末尾（只改 order，不改文本）。
 * @param assembly - 含 sections 的 assembly。
 * @returns 新的 assembly（原对象不改）。
 */
function orderSectionsStable (assembly) {
  if (process.env.DSH_RECLAIM_ORDER === '0') return assembly
  const sections = Array.isArray(assembly?.sections) ? assembly.sections : null
  if (sections === null || sections.length < 2) return assembly
  const stable = []
  const volatile = []
  for (const sec of sections) {
    const nm = String(sec?.name ?? '')
    const t = String(sec?.text ?? sec?.content ?? '')
    /*：按**行为**判定（见 isVolatileSegByBehavior 的注释）——
       不再看段名里有没有关键词。新增的段保守判易变；连续 3 次不变转稳定。 */
    if (isVolatileSegByBehavior(nm, t)) volatile.push(sec)
    else stable.push(sec)
  }
  if (volatile.length === 0 || stable.length === 0) return assembly
  /* 原顺序已是"稳定的都在前"⇒ 不动（避免无谓破前缀）。 */
  const firstVolatileIdx = sections.findIndex((x) => volatile.includes(x))
  const lastStableIdx = sections.length - 1 - [...sections].reverse().findIndex((x) => stable.includes(x))
  if (firstVolatileIdx > lastStableIdx) return assembly
  const next = stable.concat(volatile)
  const base = 100
  const ordered = next.map((sec, i) => (sec?.order !== undefined ? { ...sec, order: base + i } : sec))
  try { console.error('[reclaim/section-order] 段重排：稳定 ' + stable.length + ' 段在前 · 易变 ' + volatile.length + ' 段后置') } catch { /* ignore */ }
  return { ...assembly, sections: ordered }
}
/* ===========================================================================
 * R28：把「插件目录段」从 system 前部**搬到消息尾部** —— 无损搬位置。
 *
 * ═══ 为什么（ 实测，会话 74d7c228）═══
 *   · 整包 prompt 已到 **74.8 万 tok**，而 system 提示只占 **1.7 万 tok（2%）**
 *   · 缓存是**前缀**匹配 ⇒ system 在请求最前面 ⇒ 它任何位置变一个字节，
 *     后面整个 74.8 万全部失效
 *   · 今天 38 次「全 miss」（占调用 4.7%）吃掉 **89.2%** 的 miss，
 *     而断裂原因里 system+prefix 占 78%
 *   · 逐行 diff 定位：反复进出的就是这段「可用插件与 MCP 工具」目录
 *     （一次 -29 行、一次 +104 行；22 秒内 -29 → +24 来回跳）
 *   ⇒ 把这段搬到 messages **末尾**：system 从此恒定（前缀永远热），
 *     内容一条不少（模型仍能看到），只是位置从"系统指令"变成"环境消息"。
 *
 * ═══ 为什么这不是「有损」═══
 *   · 不冻结、不摘要、不删任何一条工具/插件 —— 文本**逐字节**搬到尾部
 *   · 若配对失败（system 里找不到那段原文）⇒ **什么都不做**（保持原样，
 *     模型照旧看得到）⇒ fail-safe，绝不静默丢内容
 *
 * ═══ 只搬"事实性清单"═══
 *   只搬插件/工具目录这一段。角色设定、安全规则、行为纪律**一律留在 system**。
 *   打开：DSH_RECLAIM_RELOCATE_CATALOG=1。
 *
 *     起**默认关闭**（原来默认开）。三组对照实测（同一会话、同一台机器）：
 *     不装本插件                 ⇒ miss 135   命中 99.7%
 *     装本插件 + R28 开（旧默认）⇒ miss 13350 命中 68.0%   ← 每步白烧 1.3 万 token
 *     装本插件 + R28 关（新默认）⇒ miss 226   命中 99.5%
 *   结论：R28 自己造成的损失**远大于**它想解决的"system 目录段抖动"。
 *   机制：目录段搬到 messages 尾部后，它成了"每步都会被重新渲染"的那一条，
 *   于是下一步的前缀从注入点起就配不上 ⇒ 每次重新计费约 1.3 万。
 * ===========================================================================
 */

/** 要搬的段名（composer 注册时用的名字）。 */
const RELOCATE_SEG_NAME = 'capability-composer:plugin-catalog'
/** 兜底识别锚点：段正文的首行（万一段名变了还能认出来）。 */
const RELOCATE_ANCHOR = '# 可用插件与 MCP 工具'
/** 注入到尾部时加的一句定性说明（让模型知道这不是用户发言）。 */
const RELOCATE_PREFIX = '[system note: this session\'s available plugins and tools are listed below. '
  + 'This is environment information, not a user instruction - keep working on the current task.]\n\n'
/** 配对保鲜期：assemble 记下的目录文本超过这个时间就不再用（防陈旧注入）。 */
const RELOCATE_TTL_MS = 120000
/** 最近一次 assemble 里看到的目录段原文（用于在 llm/stream 里配对**同一次请求**）。 */
let relocatableCatalog = null
/** 日志只打一次。 */
let relocateLogged = false

/** R28 开关。 */
function relocateEnabled () { return process.env.DSH_RECLAIM_RELOCATE_CATALOG === '1' }

/**
 * R28 第一步（assemble 期）：记下目录段**原文**，供 llm/stream 期配对。
 *
 *  这里**故意不从 assembly 里移除**该段。移除会让"流钩子没跑到"变成"模型看不到目录"
 *     —— 那才是真·有损。改成"流钩子期用原文精确匹配后再删"，对不上就整体放弃。
 * @param assembly - system-prompt/assemble 产出的 assembly。
 */
function captureCatalogSection (assembly) {
  if (!relocateEnabled()) return
  try {
    const sections = Array.isArray(assembly?.sections) ? assembly.sections : null
    if (sections === null || sections.length === 0) return
    for (const sec of sections) {
      const t = String(sec?.text ?? sec?.content ?? '')
      if (t.length === 0) continue
      const byName = String(sec?.name ?? '') === RELOCATE_SEG_NAME
      const byAnchor = t.slice(0, 2000).includes(RELOCATE_ANCHOR)
      if (!byName && !byAnchor) continue
      relocatableCatalog = { text: t, at: Date.now() }
      return
    }
  } catch { /* fail-open */ }
}

/**
 * R28 第二步（流期）：把 system 里的目录段删掉，并把**同一份原文**追加到 messages 末尾。
 *
 * 配对依据是「文本精确匹配」而不是 routeKey —— 因为 routeKeyOf 只到
 * `provider|model|main/aux`，分不出会话/agent；而目录原文是这一次请求独有的，
 * 命中即说明就是它。对不上 ⇒ 返回原数组（零副作用）。
 * @param messages - llm/stream 的 options.messages。
 * @returns 新的 messages（或原数组）。
 */
function relocateCatalogToTail (messages) {
  if (!relocateEnabled()) return messages
  const pend = relocatableCatalog
  if (pend === null) return messages
  if (Date.now() - pend.at > RELOCATE_TTL_MS) { relocatableCatalog = null; return messages }
  if (!Array.isArray(messages) || messages.length === 0) return messages
  /* 只认开头连续的那条 system（DSH 把系统提示渲染成第一条 system 消息）。 */
  let sysIdx = -1
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.role === 'system') { sysIdx = i; break }
    break
  }
  if (sysIdx < 0) return messages
  const sysMsg = messages[sysIdx]
  const blocks = Array.isArray(sysMsg?.content) ? sysMsg.content : null
  if (blocks === null) return messages
  let hit = false
  const nextBlocks = blocks.map((b) => {
    if (hit || b?.type !== 'text') return b
    const t = String(b.text ?? '')
    if (!t.includes(pend.text)) return b
    hit = true
    return { ...b, text: t.replace(pend.text, '') }
  })
  if (!hit) {
    /* 对不上 ⇒ 整体放弃（保持原样）。这就是"无损"的兜底。 */
    relocatableCatalog = null
    return messages
  }
  const out = messages.slice()
  out[sysIdx] = { ...sysMsg, content: nextBlocks }
  out.push({ role: 'user', content: [{ type: 'text', text: RELOCATE_PREFIX + pend.text }] })
  if (!relocateLogged) {
    relocateLogged = true
    try {
      console.error('[reclaim/relocate-catalog] 插件目录段已从 system 搬到消息尾部：'
        + pend.text.length + ' 字符（system 减轻 ≈' + Math.round(pend.text.length / 3.9) + ' tok）'
        + ' · 关闭：DSH_RECLAIM_RELOCATE_CATALOG=0')
    } catch { /* ignore */ }
  }
  return out
}
/* ===========================================================================
 * R25：抹平**消息里**的易变注入 —— 真机定位到的最大破前缀元凶。
 *
 * 证据（1622 条 user/message 的注入块统计）：
 *   Current runtime context             出现 768 次 · 长度 100+ 种  ← 每帧都不同
 *   engram_memory_context               出现 150 次 · 长度 130+ 种
 *   [Automatically retrieved knowledge] 出现  82 次 · 长度  48 种
 *   system-reminder（技能目录）          出现 199 次 · 长度   7 种
 *   ⇒ 它们都在 messages 里 ⇒ **每次内容变一次，前缀就断一次**。
 *   而 cache-break 里 system+prefix 104 次居首、prefixLen 只有 8 ⇒ 完全吻合。
 *
 * 做法：对这些注入块里的**易变片段**做归一化（只动"对模型无意义"的部分）：
 *   · ISO 时间戳（T12:34:56.789Z）⇒ 固定占位；
 *   · uptime / 秒数 / 耗时类数字 ⇒ 固定占位；
 *   · session id / turn 序号等长 ID ⇒ 固定占位。
 *    只动这些"每帧必变"的字段，正文（记忆内容、知识片段、技能名）**一个字节都不动**。
 *   归一化后每帧文本一致 ⇒ 这些块不再破前缀（它们的内容本来就不是靠时间戳传达的）。
 * 关掉：DSH_RECLAIM_TS_FREEZE=0。
 * ===========================================================================

/** ISO 时间戳（含毫秒/时区）。 */
const ISO_TS_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g
/** "uptime: 57.3s" / "elapsed 1m23s" / "took 4574 ms" 之类的耗时。 */
const ELAPSED_RE = /\b(uptime|elapsed|took|duration|耗时|用时)\s*[:：]?\s*\d+(?:\.\d+)?\s*(ms|s|sec|seconds|m|min|minutes)?/gi

/**
 * R25：抹平一段文本里的"每帧必变"片段（时间戳 / 耗时 / 长 ID）。
 * @param text - 原文。
 * @returns 归一化后的文本。
 */
function freezeVolatile (text) {
  if (process.env.DSH_RECLAIM_TS_FREEZE === '0') return String(text ?? '')
  return String(text ?? '')
    .replace(ISO_TS_RE, '<ts>')
    .replace(ELAPSED_RE, '$1: <n>')
}

/**
 * R25：对 messages 里的注入块做时间戳/耗时归一化（发送前，不改会话记录）。
 * @param messages - 消息数组。
 * @returns 新的消息数组（无变化则原样返回）。
 */
function freezeMessageVolatility (messages) {
  if (process.env.DSH_RECLAIM_TS_FREEZE === '0') return messages
  if (!Array.isArray(messages) || messages.length === 0) return messages
  let changed = false
  const next = messages.map((m) => {
    const inner = m?.message ?? m
    const cs = inner?.content
    if (!Array.isArray(cs)) return m
    let local = false
    const nextCs = cs.map((c) => {
      const t = c?.text
      if (typeof t !== 'string' || t.length === 0) return c
      const f = freezeVolatile(t)
      if (f === t) return c
      local = true
      return { ...c, text: f }
    })
    if (!local) return m
    changed = true
    const nextInner = { ...inner, content: nextCs }
    return m?.message !== undefined ? { ...m, message: nextInner } : nextInner
  })
  return changed ? next : messages
}
/* ===========================================================================
 * R26：剥掉**历史 assistant 消息里的 reasoning 块** —— 最大的一块可省空间。
 *
 * 真机证据（25179 条 assistant/message · 5473 万字符，10 个大会话）：
 *   正文 text        1,907,749   3.5%
 *   思考 reasoning  29,366,763  53.7%   ← 大头
 *   工具参数        23,338,252  42.6%
 *   ⇒ reasoning 占助手消息的 53.7%；而助手消息占上下文约 75%。
 *   ⇒ 界面面板实测：助手消息 ≈109.8k（75%），其中 reasoning ≈59k = 整个 prompt 的 ~36%。
 *
 * 三家的做法对比：
 *   · Reasonix（internal/agent/reasoning_replay.go 的 preserveRawReasoning）：
 *       **能不带就不带** —— 只有 signature/reasoningID/reasoningStatus 存在，
 *       或 provider.RequiresAssistantReasoningReplay() 为真时才保留原文。
 *   · DSH 官方（dsh-llm-deepseek 的 serializeAssistant）：
 *       **无条件带** —— "...reasoning.length > 0 ? { reasoning_content: reasoning } : {}"，
 *       没有任何开关，只要历史里有 reasoning 就每帧发回去。
 *   · 本插件（R26）：跟 Reasonix 一样默认不带，但**保留最近 N 轮**（默认 2，
 *       对齐 Reasonix 的 activeTurnKeepRounds = 2）。
 *
 *  为什么这样做**不破前缀**
 *   "不带"是一个**每帧都一样的确定性变换** ⇒ 剥离后的文本恒定 ⇒ 前缀稳定。
 *   只在第一次启用时破一次，之后与正常前缀无异。
 *   （这与 R23/R24/R25 同一思路：把"每帧会变的东西"变成"每帧都一样的"。）
 *
 *  无损性：
 *   reasoning 是模型的**草稿**，不是给模型的指令（工具参数才是）。
 *   历史轮次的草稿对后续推理没有约束力；当前轮/最近轮保留 ⇒ 接着做同一件事时思考仍在。
 *   fail-open：任何异常一律原样放行，绝不把成功请求变成一个失败请求。
 *
 * 开关：DSH_RECLAIM_STRIP_REASONING=0 关闭；DSH_RECLAIM_KEEP_REASONING_TURNS=<n> 改保留轮数。
 * ===========================================================================

/** 默认保留最近几轮的 reasoning（对齐 Reasonix 的 activeTurnKeepRounds = 2）。 */
const KEEP_REASONING_TURNS_DEFAULT = 2

/** 统计一组消息里 reasoning 块的字符总量（R26 用）。 */
function countReasoningChars (messages) {
  let chars = 0
  if (!Array.isArray(messages)) return 0
  for (const m of messages) {
    const inner = m?.message ?? m
    if (!Array.isArray(inner?.content)) continue
    for (const c of inner.content) if (String(c?.type ?? '') === 'reasoning') chars += String(c?.text ?? '').length
  }
  return chars
}

/**
 * R26：剥掉历史 assistant 消息里的 reasoning 块，只保留最近 N 轮的。
 *
 *：**默认改为关**（原来 `=== '0'` 是"不设就开"）。
 *
 * 为什么改默认值：当前机器一直靠"设 `DSH_RECLAIM_STRIP_REASONING=0`"来关它，
 * 但**新装机器不会设这个变量** ⇒ 每步都剥 ⇒ **每条 assistant 消息的内容每步都不同**
 * ⇒ 前缀反复断裂（实测：剥 18,704 tok 的那一步，`miss` 从 1,076 跳到 46,232）。
 *
 * 原则：**破前缀的功能，默认必须关。**
 * 打开（旧行为）：`DSH_RECLAIM_STRIP_REASONING=1`。
 *
 * @param messages - 要发送的消息数组。
 * @returns 新的消息数组（无变化则原样返回同一个引用）。
 */
function stripHistoryReasoning (messages) {
  if (process.env.DSH_RECLAIM_STRIP_REASONING !== '1') return messages
  if (!Array.isArray(messages) || messages.length === 0) return messages
  let keep = KEEP_REASONING_TURNS_DEFAULT
  const rawKeep = process.env.DSH_RECLAIM_KEEP_REASONING_TURNS
  if (rawKeep !== undefined) {
    const n = Number(rawKeep)
    if (Number.isFinite(n) && n >= 0) keep = Math.floor(n)
  }
  const inner = (m) => (m === null || typeof m !== 'object' ? null : (m.message !== null && typeof m.message === 'object' ? m.message : m))
  /*  关键：一轮 = 一条**真用户**消息（source.kind === user）。
     实测 DSH 里 role=user 的消息有四种来源：
       kind=user          真用户消息     ← 只数这个
       kind=tool          工具结果
       kind=plugin        插件注入（dsh-system-prompt / dsh-engram）
       kind=skill-catalog 技能目录
     首版只判 role==user ⇒ 工具结果被当成"轮" ⇒ 463 个假轮 ⇒
     "最近 2 轮"落到最后 2 条工具结果上 ⇒ 等于不保护（实测剥掉 100%）。 */
  const isUserTurn = (m) => String(m?.role ?? '') === 'user' && String(m?.source?.kind ?? '') === 'user'
  let protectStart = messages.length
  if (keep > 0) {
    let found = 0
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (!isUserTurn(inner(messages[i]))) continue
      found += 1
      if (found === keep) { protectStart = i; break }
    }
    /* 边界要分开：
       found === 0 ⇒ 一条真用户都没有（异常/极短会话）⇒ 没有"轮"可保留 ⇒ 全剥；
       found < keep 但 > 0 ⇒ 会话刚开、轮数不够 ⇒ 全保护（不剥）。 */
    if (found === 0) protectStart = messages.length
    else if (found < keep) protectStart = 0
  }
  const protectFrom = messages.map((_m, i) => i >= protectStart)
  let changed = false
  const next = messages.map((m, i) => {
    if (protectFrom[i]) return m
    const mInner = inner(m)
    if (mInner === null || String(mInner.role ?? '') !== 'assistant') return m
    const cs = mInner.content
    if (!Array.isArray(cs)) return m
    const kept = cs.filter((c) => String(c?.type ?? '') !== 'reasoning')
    if (kept.length === cs.length) return m
    changed = true
    const nextInner = { ...mInner, content: kept }
    return m?.message !== undefined ? { ...m, message: nextInner } : nextInner
  })
  return changed ? next : messages
}
/** 注入行的形状（外部记忆插件把"最近记忆/用户消息"塞进快照时用的前缀）。 */
const INJECT_LINE_RE = /^\s*-\s*\[contextual\]\s*/
/**
 *：**默认改为关**（原来 `!== '0'` 是"不设就开"）。
 *
 * 为什么关：它**改写 messages**（删掉"与历史重复的注入行"）⇒ 与"剥推理"同类，
 * **一旦真的删掉某一行，前缀就从那里起全废**。
 * 实测它**一次都没触发过**（`reclaim/inject-dedupe` 0 次）—— 因为判据是"取前 60 字符
 * 去历史里找"，而注入内容每帧都在变（时间戳/序号），永远匹配不上。
 * ⇒ 留着它是"随时可能破前缀、却从没带来收益"。
 *
 * 原则：**会破前缀的功能，默认必须关。** 想用：`DSH_RECLAIM_INJECT_DEDUPE=1`。
 */
const INJECT_DEDUPE_ON = process.env.DSH_RECLAIM_INJECT_DEDUPE === '1'
const INJECT_MIN_CHARS = intEnv('DSH_RECLAIM_INJECT_MIN_CHARS', 24)

/**
 * 把 messages 拼成一段可检索文本（用于判断"注入行是否已在历史里"）。
 * @param messages - 对话消息数组。
 * @returns 拼接文本（小写归一）。
 */
function historyTextOf (messages) {
  let out = ''
  for (const m of (Array.isArray(messages) ? messages : [])) {
    const inner = m?.message ?? m
    const cs = inner?.content
    if (Array.isArray(cs)) {
      for (const c of cs) {
        if (typeof c?.text === 'string') out += c.text + '\n'
      }
    } else if (typeof cs === 'string') out += cs + '\n'
  }
  return out
}

/*  R19实测后加的"最强一条"）：把工具选择规则**写进工具描述**。
 *
 * 为什么必须这样做：R18 把纪律追加在 **system prompt 末尾**，实测**不够** —— 实际会话里
 *   write 次数 18 → 27（反而更多），助手消息 59.1k → 79.5k（60%）。
 *   原因：**模型选工具时读的是工具自己的 description**，系统提示末尾的"纪律"容易被忽略。
 * 做法：在 wire 上的 tools 数组里，给 write/write_file/create_file 这类"整篇重写"工具
 *   的 description **前面**插一句硬提示（点明代价：整篇正文会再发一遍上下文）。
 * 缓存代价：工具定义在请求最前面 ⇒ 只破一次前缀（之后每帧一致）。
 * 关：DSH_RECLAIM_TOOL_HINT=0。
 */
const TOOL_HINT_ON = process.env.DSH_RECLAIM_TOOL_HINT !== '0'
const REWRITE_TOOL_RE = /^(write|write_file|create_file|save_file|overwrite_file)$/
/*   加强（实测 write 次数 18 → 27 → 48，光靠 write 的 description 拦不住）：
   11 个文件写了 48 次（平均每个重写 4.4 次）——**反复整篇重写同一文件是最贵的模式**。
   加两道：① edit 的 description 反向强调；② write 的 content **参数**上加警告（离决策点更近）。 */
const EDIT_TOOL_RE = /^(edit|edit_file|str_replace|apply_patch|multi_edit)$/
/* 语言选择：
   中文版 62 字符 ≈ 31 tok；英文版 118 字符 ≈ 30 tok —— **几乎一样**（而且工具定义只发一次、
   之后全命中缓存）⇒ 这里**不是**省 token 的地方。
   选英文的真实理由：**硬指令的服从度**。这一段的作用是"拦住 write"，服从度 > 那点 token 差异。 */
/*   第三版（实测 48 → 17 次写入，方向对但还不够）。
   这次把"用 write 改已有文件"从"不推荐"升级为**明确的错误操作**，并给出可执行的判定阈值。 */
/*   v4（实测写入 13 次，还想再降）：
   根因是 v3 里那句 "unless … replacing more than 60% of it" —— **它给模型留了借口**
   （"我加了几个功能，算改得多" ⇒ 就用 write 了）。
   ⇒ 去掉一切例外：**文件已存在就绝不能用本工具**（无条件规则，不需要模型自己判断比例）。
   比例这种事模型算不准 ⇒ 任何需要它"自己掂量"的措辞都会被滥用。 */
const TOOL_HINT = '[CREATE NEW FILES ONLY. If the file already exists — even if you plan to change most of ' +
  'it — this tool is the WRONG choice: it re-sends the ENTIRE file into the conversation context. ' +
  'Use edit, anchored on the lines you need to change. Never re-send a file body you have already ' +
  'read or written in this session.] [dshreclaim] '
const EDIT_HINT = '[dshreclaim] [THE tool for changing any existing file — including large changes to many parts of it. ' +
  'Do it as one or more edit calls (each anchored on the lines it replaces); never switch back to write ' +
  'once the file exists. Only brand-new files may use write.] '
const CONTENT_WARN = 'Do NOT pass whole existing files here — the ENTIRE value is re-sent into the ' +
  'conversation context. For any file that already exists (or that you wrote earlier in this session), ' +
  'use edit instead and send only the changed lines.] [dshreclaim] ' 

/**
 * R19：把"优先 edit"的提示插进"整篇重写"类工具的 description。
 * @param tools - wire 上的工具数组。
 * @returns 新的工具数组（原数组不改；无命中则原样返回）。
 */
function hintRewriteTools (tools) {
  if (!TOOL_HINT_ON || !Array.isArray(tools) || tools.length === 0) return tools
  let changed = false
  const out = tools.map((t) => {
    if (t === null || typeof t !== 'object') return t
    const src = t.function !== undefined ? t.function : t
    const name = String(src?.name ?? '')
    const isRewrite = REWRITE_TOOL_RE.test(name)
    const isEdit = EDIT_TOOL_RE.test(name)
    if (!isRewrite && !isEdit) return t
    const desc = String(src?.description ?? '')
    /*  幂等判断用固定 marker（与文案解耦）—— 之前用 startsWith('文案前缀') 导致
       每次改措辞都要同步修，已经踩过两次。 */
    const already = desc.includes('[dshreclaim]')
    if (already) return t
    changed = true
    const nextDesc = (isRewrite ? TOOL_HINT : EDIT_HINT) + desc
    /*  参数级警告：write 的 content 参数上再钉一句（离模型决策点最近）。 */
    let nextParams = src?.parameters
    const props = nextParams?.properties
    const cp = props?.content
    if (isRewrite && props !== null && props !== undefined && typeof props === 'object'
      && cp !== null && cp !== undefined && typeof cp === 'object' && typeof cp.description === 'string'
      && !cp.description.includes('[dshreclaim]')) {
      nextParams = { ...nextParams, properties: { ...props, content: { ...cp, description: CONTENT_WARN + cp.description } } }
    }
    const nextFn = { ...src, description: nextDesc }
    if (nextParams !== src?.parameters) nextFn.parameters = nextParams
    return t.function !== undefined ? { ...t, function: nextFn } : nextFn
  })
  return changed ? out : tools
}

/**
 * R21：把"改动过于集中"的软提醒追加到 system prompt 末尾（**只在该状态成立时加**）。
 * 触发后文本固定 ⇒ 最多破一次前缀；状态解除（改了别的文件）后不再加。
 * @param assembly - 含 sections 的 assembly。
 * @returns 新的 assembly。
 */
function appendBudgetNudge (assembly) {
  if (!BUDGET_NUDGE_ON || !budgetState.nudgeActive) return assembly
  const sections = Array.isArray(assembly?.sections) ? assembly.sections : null
  if (sections === null || sections.length === 0) return assembly
  for (const sec of sections) if (String(sec?.text ?? '').includes('[dshreclaim-nudge]')) return assembly
  const text = '\n\n## 改动集中度提醒 [dshreclaim-nudge]\n\n' +
    '你正在短时间内反复修改同一个文件。请先一次性想清楚要改什么，再用更少的 edit 调用完成；' +
    '不要靠反复重写来试探。\n'
  const last = sections[sections.length - 1]
  const merged = String(last?.text ?? '') + text
  return { ...assembly, sections: sections.slice(0, -1).concat([last?.text !== undefined ? { ...last, text: merged } : { ...last, content: merged }]) }
}

/**
 * R18：把"输出纪律"追加到 system prompt 的**末尾**（末尾追加不破前缀）。
 * @param assembly - 含 sections 的 assembly。
 * @returns 新的 assembly（幂等：已有则不重复追加）。
 */
function appendOutputDiscipline (assembly) {
  if (!OUTPUT_DISCIPLINE_ON) return assembly
  const sections = Array.isArray(assembly?.sections) ? assembly.sections : null
  if (sections === null || sections.length === 0) return assembly
  for (const sec of sections) if (String(sec?.text ?? '').includes('上下文预算纪律')) return assembly
  const last = sections[sections.length - 1]
  const merged = String(last?.text ?? '') + '\n\n' + OUTPUT_DISCIPLINE_TEXT
  const next = sections.slice(0, -1).concat([last?.text !== undefined ? { ...last, text: merged } : { ...last, content: merged }])
  return { ...assembly, sections: next }
}

/**
 * R17：对 assembly 里的注入段做逐行去重。
 * @param assembly - 含 contexts/sections 的 assembly。
 * @param messages - 对话消息（判断依据）。
 * @returns 新的 assembly（原对象不改）。
 */
function dedupeInjectedContexts (assembly, messages) {
  if (!INJECT_DEDUPE_ON) return assembly
  const containers = ['contexts', 'sections']
  let removedLines = 0
  let removedChars = 0
  let changedAny = false
  const next = { ...assembly }
  const hist = historyTextOf(messages)
  const histLower = hist.toLowerCase()
  for (const key of containers) {
    const arr = Array.isArray(assembly?.[key]) ? assembly[key] : null
    if (arr === null || arr.length === 0) continue
    let changed = false
    const out = arr.map((seg) => {
      const text = String(seg?.text ?? '')
      if (text.length === 0) return seg
      const lines = text.split('\n')
      const kept = []
      for (const l of lines) {
        const m = INJECT_LINE_RE.exec(l)
        if (m === null) { kept.push(l); continue }
        const body = l.slice(m[0].length).trim()
        /* 太短的不判（误伤风险高）；内容在历史里找得到 ⇒ 删。 */
        if (body.length < INJECT_MIN_CHARS) { kept.push(l); continue }
        const probe = body.slice(0, 60).toLowerCase()
        if (histLower.includes(probe)) { removedLines += 1; removedChars += l.length + 1; continue }
        kept.push(l)
      }
      if (kept.length === lines.length) return seg
      changed = true
      const merged = kept.join('\n').replace(/\n{3,}/g, '\n\n')
      return { ...seg, text: merged }
    })
    if (changed) { next[key] = out.filter((x) => String(x?.text ?? '').length > 0); changedAny = true }
  }
  if (!changedAny) return assembly
  try {
    console.error('[reclaim/inject-dedupe] 注入去重：删 ' + removedLines + ' 行 · ' + removedChars
      + ' 字符（≈' + Math.round(removedChars / 3.6) + ' tok）—— 这些内容在对话历史里本来就有')
  } catch { /* ignore */ }
  return next
}

/**
 * R15：对系统提示各段做"长描述行截断"。
 * @param assembly - 含 sections 的 assembly。
 * @returns 新的 assembly（原对象不改）。
 */
function trimPromptLongLines (assembly) {
  if (!PROMPT_LINE_ON) return assembly
  const sections = Array.isArray(assembly?.sections) ? assembly.sections : null
  if (sections === null || sections.length === 0) return assembly
  let saved = 0
  let changedAny = false
  const next = sections.map((sec) => {
    const text = String(sec?.text ?? sec?.content ?? '')
    if (text.length === 0) return sec
    let changed = false
    const lines = text.split('\n').map((l) => {
      if (l.length <= PROMPT_LINE_MAX) return l
      const t = l.trim()
      const bare = t.replace(LIST_PREFIX_RE, '')
      /*  指令行保护：先剥列表前缀再判，且大小写不敏感（"- DO NOT …" 也算指令）。 */
      if (INSTRUCTION_LINE_RE.test(bare)) return l
      if (/^#{1,6}\s/.test(t)) return l               /* 标题不动 */
      const cut = shortParamText(l, PROMPT_LINE_MAX)
      if (cut.length < l.length) { changed = true; saved += l.length - cut.length; return cut }
      return l
    })
    if (!changed) return sec
    changedAny = true
    return sec.text !== undefined ? { ...sec, text: lines.join('\n') } : { ...sec, content: lines.join('\n') }
  })
  if (!changedAny) return assembly
  try { console.error('[reclaim/prompt-line] 系统提示长行截断：省 ' + saved + ' 字符（阈值 ' + PROMPT_LINE_MAX + '）') } catch { /* ignore */ }
  return { ...assembly, sections: next }
}

function trimPromptSections (assembly, activePlugins) {
  if (!SECTION_TRIM_ON) return assembly
  const sections = Array.isArray(assembly?.sections) ? assembly.sections : null
  if (sections === null || sections.length === 0) return assembly
  const active = new Set((activePlugins ?? []).map((x) => String(x).toLowerCase()))
  const kept = []
  const dropped = []
  for (const s of sections) {
    const text = String(s?.text ?? s?.content ?? '')
    const owner = SECTION_OWNER.find(([re]) => re.test(text))?.[1]
    /*  纪律：**表里没有的段一律保留**（与 composer 同）；表里有的，看它的插件在不在组合里 */
    if (owner === undefined || active.size === 0 || active.has(owner.toLowerCase())) { kept.push(s); continue }
    dropped.push(owner)
  }
  if (dropped.length === 0) return assembly
  try {
    console.error('[reclaim/section-trim] 丢掉 ' + dropped.length + ' 段（归属：' + dropped.join('、') + '）')
  } catch { /* ignore */ }
  return { ...assembly, sections: kept }
}

/* 导出见文件末尾的 export 块（集中化：避免重复导出） */

/* ══════════════════════════════════════════════════════════════════════════
 * R3 + R4：AST 骨架化 + 日志浓缩（集中化：能力来自 dsh-context-lens，规则照抄）
 *   R3 规则来源：@goodandready/dsh-context-lens\lib\ast\skeletonizer.js（8 语言正则 + 多行签名累积）
 *   R4 规则来源：同包 \lib\compression\log-compressor.js（KEEP/STACK 保留 + PASS/NOISE 丢弃 + 上下文扩展 + 兜底保首尾）
 *
 * ═══ 零降智保障 ═══
 *   R3：① 只压"不是正在编辑的文件"（焦点文件跳过）② 原文件在磁盘 ⇒ 可重读
 *   R4：① 失败行/栈行**必留** ② 命中行前后上下文扩展 ③ 一个都没匹配就保首尾
 *   两者都**确定性**（同一输入永远同一输出）⇒ 不破缓存
 * ══════════════════════════════════════════════════════════════════════════ */

/** R3/R4 开关与阈值。 */
const AST_ON = process.env.DSH_RECLAIM_AST !== '0'
const LOG_ON = process.env.DSH_RECLAIM_LOG !== '0'
const AST_MIN_CHARS = Number(process.env.DSH_RECLAIM_AST_MIN) > 0 ? Number(process.env.DSH_RECLAIM_AST_MIN) : 6000
const AST_MAX_DEPTH = Number(process.env.DSH_RECLAIM_AST_DEPTH) > 0 ? Number(process.env.DSH_RECLAIM_AST_DEPTH) : 3
const LOG_MAX_LINES = Number(process.env.DSH_RECLAIM_LOG_MAX) > 0 ? Number(process.env.DSH_RECLAIM_LOG_MAX) : 400

/* ── R3：8 语言签名正则（照抄 skeletonizer.js） ────────────────────────── */
const AST_RES = {
  js: /^\s*(export\s+)?(async\s+)?(function\s+\w+|const\s+\w+\s*=\s*(async\s+)?\([^)]*\)\s*=>|\w+\s*:\s*(async\s+)?\([^)]*\)\s*=>|class\s+\w+)/,
  py: /^\s*(def\s+\w+\s*\([^)]*\)|class\s+\w+.*?:|async\s+def\s+\w+\s*\([^)]*\))/,
  go: /^\s*(func\s+(\([^)]+\)\s+)?\w+\s*\([^)]*\)|type\s+\w+\s+(struct|interface))/,
  rust: /^\s*(pub(\([^)]+\))?\s+)?(async\s+)?(fn|struct|enum|impl|trait|type|const|static)\s+\w+/,
  cppClass: /^\s*(?:class|struct)\s+\w+(?:\s*:\s*(?:public|protected|private)\s+\w+)?/,
  cppFunc: /^\s*(?:(?:virtual|inline|static|explicit|constexpr|friend)\s+)*(?:[\w:<>&*~]+\s+)+\w+\s*\([^)]*\)/,
  sql: /^\s*(?:CREATE|ALTER)\s+(?:TABLE|VIEW|INDEX|TRIGGER|FUNCTION|PROCEDURE)\s+/i,
}
const AST_IMPORT = /^\s*(#include\s+[<"][^>"]+[>"]|import\s+.*from\s+['"].*['"]|import\s+['"].*['"]|export\s+.*from\s+['"].*['"]|from\s+\w+\s+import\s+)/
const AST_COMMENT = /^\s*(\/\/|\/\*|\*|#|--)/
const AST_MULTILINE = /^\s*(export\s+)?(async\s+)?(function\b|const\s+\w+\s*=|\w+\s*:\s*(async\s+)?\(|def\b|async\s+def\s|class\b|pub\s+(async\s+)?fn)/

const extOf = (p) => { const m = /\.([A-Za-z0-9]+)$/.exec(String(p ?? '')); return m ? m[1].toLowerCase() : '' }
function langOfPath (p) {
  const e = extOf(p)
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(e)) return 'js'
  if (e === 'py') return 'py'
  if (e === 'go') return 'go'
  if (e === 'rs') return 'rust'
  if (['c', 'h', 'cc', 'cpp', 'hpp', 'cxx'].includes(e)) return 'cpp'
  if (e === 'sql') return 'sql'
  return null
}
const isSigLine = (line, lang) => {
  if (lang === 'js') return AST_RES.js.test(line)
  if (lang === 'py') return AST_RES.py.test(line)
  if (lang === 'go') return AST_RES.go.test(line)
  if (lang === 'rust') return AST_RES.rust.test(line)
  if (lang === 'cpp') return AST_RES.cppClass.test(line) || AST_RES.cppFunc.test(line)
  if (lang === 'sql') return AST_RES.sql.test(line)
  return AST_RES.js.test(line) || AST_RES.py.test(line) || AST_RES.go.test(line) || AST_RES.rust.test(line)
}
const indentDepth = (line) => (String(line).match(/^[ \t]*/)?.[0].replace(/\t/g, '  ').length ?? 0) / 2

/**
 *  R3：把代码压成"签名骨架"（确定性）。
 * @param {string} text - 源码。
 * @param {string} filePath - 用于判语言。
 * @returns 骨架文本（若压不动则返回 null）。
 */
function skeletonizeCode (text, filePath) {
  if (!AST_ON) return null
  const src = String(text ?? '')
  if (src.length < AST_MIN_CHARS) return null
  const lang = langOfPath(filePath)
  if (lang === null) return null
  const lines = src.split(/\r?\n/)
  const keep = new Set()
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]
    if (indentDepth(l) > AST_MAX_DEPTH) continue
    if (AST_IMPORT.test(l) || AST_COMMENT.test(l) || isSigLine(l, lang)) {
      keep.add(i)
      /* 多行签名累积：签名未以 { / => / : 结束 ⇒ 连带下一行 */
      if (AST_MULTILINE.test(l) && !(/[{:]\s*$/.test(l) || /=>\s*$/.test(l))) {
        let j = i + 1
        while (j < lines.length && !lines[j].trim()) j += 1
        if (j < lines.length) keep.add(j)
      }
    }
  }
  /*  兜底：一个都没匹配 ⇒ 返回 null（宁可不压，不做无意义替换） */
  if (keep.size < 8) return null
  const out = []
  let prev = -2
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i > prev + 1) out.push('… [' + (i - prev - 1) + 'L cut] …')
    out.push(lines[i])
    prev = i
  }
  if (prev < lines.length - 1) out.push('… [' + (lines.length - 1 - prev) + 'L cut] …')
  const joined = out.join('\n')
  /*  只有确实变小才用 */
  if (joined.length >= src.length * 0.7) return null
  return joined
}

/* ── R4：日志浓缩（照抄 log-compressor.js 的规则） ─────────────────────── */
const ANSI_RE = /\u001b\[[0-9;]*[a-zA-Z]/g
const LOG_KEEP = /(FAIL|FAILED|Error|AssertionError|Exception|Traceback|panic|npm ERR!|ERR!|Expected|Received|missing|×|●|✕|FATAL|fatal|WARN.*fail)/i
const LOG_PASS = /^(PASS|\s*✓|\s*✔|\s*ok\s|test result:\s*ok|running \d+ test.*ok|\s*\.\s*$|\s*…+\s*$)/i
const LOG_NOISE = /^\s*(npm (notice|warn|info)|Browserslist|cached|Downloading|Done in|Compiling\s|cargo:.*Finished|added \d+ package)/i
const LOG_STACK = /^\s*(at\s+|File ".*", line \d+|#\d+\s+0x|goroutine \d+ \[|thread '.*' panicked|note: run with|\s+in <|Caused by:)/

const stripAnsi = (s) => String(s ?? '').replace(ANSI_RE, '')
const isKeepLine = (l) => LOG_KEEP.test(l) || LOG_STACK.test(l)

/**
 *  R4：浓缩日志（确定性）。
 * @param {string} text - 日志。
 * @returns 浓缩文本（压不动则 null）。
 */
function compressLog (text) {
  if (!LOG_ON) return null
  const raw = String(text ?? '')
  if (raw.split('\n').length < 60) return null
  const lines = stripAnsi(raw).split(/\r?\n/)
  const keep = new Array(lines.length).fill(false)
  for (let i = 0; i < lines.length; i += 1) {
    if (isKeepLine(lines[i])) {
      /* 上下文扩展：命中行前后各 1 行 */
      for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 1); j += 1) keep[j] = true
    }
  }
  /*  兜底：一个都没匹配 ⇒ 保首尾各 20 行（当作提示） */
  if (!keep.some(Boolean)) {
    for (let i = 0; i < Math.min(20, lines.length); i += 1) keep[i] = true
    for (let i = Math.max(0, lines.length - 20); i < lines.length; i += 1) keep[i] = true
  }
  const out = []
  let prev = -2
  let kept = 0
  for (let i = 0; i < lines.length; i += 1) {
    if (!keep[i]) continue
    if (LOG_PASS.test(lines[i]) && !isKeepLine(lines[i])) continue
    if (LOG_NOISE.test(lines[i]) && !isKeepLine(lines[i])) continue
    if (kept >= LOG_MAX_LINES) break
    if (i > prev + 1) out.push('… [' + (i - prev - 1) + 'L cut] …')
    out.push(lines[i])
    prev = i
    kept += 1
  }
  if (kept === 0) return null
  if (prev < lines.length - 1) out.push('… [' + (lines.length - 1 - prev) + 'L cut] …')
  const joined = out.join('\n')
  if (joined.length >= raw.length * 0.7) return null
  return joined
}
function isHumanUser (m) {
  if (m?.role !== 'user') return false
  if (m?.source?.kind === 'user') return true
  const blocks = Array.isArray(m.content) ? m.content : []
  return !blocks.some((b) => b?.type === 'tool-result')
}

/** 冻结前缀 = 最后一条人类 user 的下标。 */
function intEnv (name, dflt) {
  const v = Number(process.env[name])
  return Number.isInteger(v) && v >= 0 ? v : dflt
}

/** 归档：单条上限、总量上限、条数上限（都是环境变量可调）。 */
const ARCHIVE_ON = process.env.DSH_RECLAIM_ARCHIVE !== '0'
const ARCHIVE_MAX_BYTES = intEnv('DSH_RECLAIM_ARCHIVE_MAX_BYTES', 40000)
const ARCHIVE_MAX_TOTAL_MB = intEnv('DSH_RECLAIM_ARCHIVE_MAX_MB', 24)
const ARCHIVE_MAX_TOTAL = ARCHIVE_MAX_TOTAL_MB * 1024 * 1024
const ARCHIVE_MAX_ENTRIES = intEnv('DSH_RECLAIM_ARCHIVE_MAX_ENTRIES', 2000)
/** 距最近人类 user ≥ 此轮数的结果才归档（保留区之外的才动）。 */
const ARCHIVE_AFTER_TURNS = intEnv('DSH_RECLAIM_ARCHIVE_AFTER_TURNS', 1)
/** stale output：调用对距最近 user ≥ N 轮才算陈旧。 */
const SCREEN_STALE_TURNS = intEnv('DSH_RECLAIM_STALE_TURNS', 1)
/** failed call：同上。 */
const SCREEN_FAILED_TURNS = intEnv('DSH_RECLAIM_FAILED_TURNS', 3)
/** oversized：单块文本超此字符数则头尾裁剪（照抄 triage 的 capChars 语义）。 */
const SCREEN_OVERSIZED_CAP = intEnv('DSH_RECLAIM_OVERSIZED_CAP', 20000)
const SCREEN_OVERSIZED_HEAD = intEnv('DSH_RECLAIM_OVERSIZED_HEAD', 6000)
const SCREEN_OVERSIZED_TAIL = intEnv('DSH_RECLAIM_OVERSIZED_TAIL', 2000)
/** stale reasoning：**保留区内**超此长度就裁剪（只剪不删）；删除交给 R6。 */
const SCREEN_REASONING_MAX_CHARS = intEnv('DSH_RECLAIM_REASONING_MAX', 8000)
/** 失败调用：错误文本保留的头部长度（旧口径，仅兼容）。 */
const SCREEN_FAILED_KEEP_CHARS = intEnv('DSH_RECLAIM_FAILED_KEEP', 2000)
/** 失败结果：整块字符上限（超了才裁）。 */
const SCREEN_FAILED_CAP_CHARS = intEnv('DSH_RECLAIM_FAILED_CAP', 6000)
/** 失败结果：尾部至少保留（照 Reasonix：≥ cap/3 再取大者）。 */
const SCREEN_FAILED_TAIL_CHARS = intEnv('DSH_RECLAIM_FAILED_TAIL', 2000)
/** 豁免工具（不可复现 / 有副作用 / 取回通道本身）。 */
const SCREEN_EXEMPT_TOOLS = new Set(
  (process.env.DSH_RECLAIM_EXEMPT_TOOLS ?? 'web_fetch,web_search,job_output,ask_user,read_tool_result_log')
    .split(',').map((s) => s.trim()).filter(Boolean))
/** 豁免路径 glob（默认空 —— 宁可不动）。 */
const SCREEN_EXEMPT_GLOBS = (process.env.DSH_RECLAIM_EXEMPT_GLOBS ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean)

/** 裁剪标记预算（照抄 triage 的 ELLIPSIS_BUDGET）。 */
const CLIP_ELLIPSIS_BUDGET = 40

/* ══════════════════════════════════════════════════════════════════════════

/** 本进程的 wire 请求序号（与 PAYLOAD_STATS.calls 分开，避免与日志口径互相干扰）。 */

/** routeKey：provider|model|main|aux（与 C4 修复的分桶口径同一处，避免两套算法漂移）。
 *
 *：**追加「会话指纹」**。
 *
 * 为什么要加：`shapeByRoute` 存的是"上一次请求的逐条消息形状"，用来算 `firstDiff`
 * （日志里"从第 K+1 条起就不同了"）。但原来的 key 只有 `provider|model|main`
 * ⇒ **同一台机器上所有会话共用一个比较槽** ⇒ 一切换会话，第 1 条必然不同
 * ⇒ 实测 1413 条 usage 里 51 条报 `firstDiff=1`，**其中大半是"跨会话对比"的噪音**，
 * 会被误读成"同一会话内前缀被改写"（ 我就据此误判过一次）。
 *
 * 加指纹后：**只有同一个会话内的前后两次请求才会互相比较** ⇒ firstDiff 说真话。
 * 指纹取 `messages[1]` 的内容哈希 —— index 0 是 system，index 1 是**会话第一条用户消息**，
 * 它对同一会话恒定、跨会话必然不同。
 *
 * 影响面：**只改诊断日志的准确性**，不碰任何缓存行为与工具面。fail-open（算不出就用旧 key）。 */
function routeKeyOf (options) {
  const tools = Array.isArray(options?.tools) ? options.tools : []
  const base = String(options?.provider ?? '?') + '|' + String(options?.model ?? '?') + '|' + (tools.length > 0 ? 'main' : 'aux')
  try {
    const msgs = Array.isArray(options?.messages) ? options.messages : []
    const anchor = msgs[1] ?? msgs[0]
    if (anchor === undefined || anchor === null) return base + '|noanchor'
    return base + '|' + shapeHash(JSON.stringify(anchor))
  } catch {
    return base + '|nofp'
  }
}

let wireCallSeq = 0
/** R25 证据行只打一次。 */
let volatileFreezeLogged = false
/* 诊断用：system prompt dump 的序号（DSH_RECLAIM_DUMP_SYSTEM=1 时递增）。 */
let systemDumpSeq = 0
/** R26：上次记录的"剥掉量"，变化时才打日志（首次必打）。 */
let lastReasoningSaved = -1

/* 导出见文件末尾 */

/** 供测试直接调用。 */
export {
  purify, bound, kindOf,
  pointerFor, collapseCarriageReturns, flattenPlainText,
  CAP_DEFAULTS, READ_ONLY_TOOLS, SIDE_EFFECT_TOOLS,
  FAITHFUL_TOOLS, shapeOf, compareShape,
  recordCacheReceipt, cacheReceipts, foldToolSurface,
  trimPromptSections, trimPromptLongLines, dedupeInjectedContexts, appendOutputDiscipline, hintRewriteTools,
  stabilizeCounts, stabilizePromptCounts, orderSectionsStable, freezeVolatile, freezeMessageVolatility, stripHistoryReasoning,
  captureCatalogSection, relocateCatalogToTail,
  noteToolCall, maybeReportBudget, appendBudgetNudge, budgetState,
  checkDuplicateEdit, dedupSeen,
  bm25Rank,
  shortToolDescription, slimSchema, skeletonizeCode,
  compressLog, notePayloadShape, PAYLOAD_STATS,
  simulateWireShape, estimateTextTokens, estimateBlocksTokens,
  estimateMessageTokens, estimateMessagesTokens, estimateToolSchemaTokens,
  CJK_PER_TOKEN, OTHER_PER_TOKEN, attributeGroups,
  groupOfMessage, renderGroupLine, toolSourceOf,
  GROUP_LABELS, BUILTIN_TOOL_NAMES, usageOfChunk,
  recordUsage, lastPromptTokensOf, WIRE_REWRITE_VERSION,
  usageByRoute, pickDynSticky, resetFoldState,
  CORE_DESC_MAX, bm25Score, STICKY_MARGIN,
  shouldReplace, checkToolPairing, isOfficialSpillNotice,
  looksTabular, delimiterProfile, TABLE_SAMPLE_LINES
}

/* ══════════════════════════════════════════════════════════════════════════
 *  官方补丁提醒（服务端半边）
 *
 *  为什么必须由本插件自己做：本插件受益的两条补丁（agent-loop 的快照回收 +
 *  系统提示收敛；以及只有跟它一起才有意义的 pi-ai splitSystemPrompt）改的是
 *  DSH 自身的机器行为，插件层表达不了。而本插件是纯服务端插件、没有界面，
 *  所以「装好之后在界面上说一次」得靠自己带一个极小的客户端半边（lib/client.js）。
 *  那条半边只读本插件自己的路由，不碰任何别的插件，也不替别人弹窗。
 *
 *  这里只做三件事：探测「打没打」、落一个「不再提醒」标记、把结论交给弹窗。
 *  永不改官方文件。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 本插件受益的官方补丁（**只列本插件相关的**，不替别的插件代言）。 */
const PATCH_NOTICE_TARGETS = [
  {
    id: 'agent-loop-snapshot-prompt',
    title: 'agent-loop：运行时快照每轮回收 + 系统提示收敛到 1 条',
    pkg: 'dsh-agent-loop',
    file: ['lib', 'index.js'],
    tier: 'recommended',
    whyZh: '不改就一直往上下文里堆：每轮的运行时快照不回收、系统提示会留多条。不打**不会坏**，但长会话会越来越慢 —— 这正是本插件想省下来的那块。',
    whyEn: 'Without it the context keeps growing: each turn keeps its runtime snapshot and more than one system prompt stays in the request. Nothing breaks, but long sessions get slower — which is exactly the budget this plugin exists to protect.'
  },
  {
    id: 'llm-pi-ai-system-prompt',
    title: 'pi-ai：splitSystemPrompt 收集开头全部 system',
    pkg: 'dsh-llm-pi-ai',
    file: ['lib', 'index.js'],
    tier: 'recommended',
    whyZh: '它是上一条的另一半，**单独打没有意义**；两条一起打，系统提示才会真的收敛成一条。',
    whyEn: 'This is the other half of the previous one and means nothing on its own; apply the two together and the system prompt actually converges to a single block.'
  }
]

/** 补丁库（独立开源仓库：10 条自包含补丁 + 自适应应用器 + 五种打法）。 */
const PATCHLIB_REPO = 'https://github.com/xiamubumu/dsh-patch-library'
/** 直接下载：永远指向最新 Release 的那个 tgz。 */
const PATCHLIB_TGZ = PATCHLIB_REPO + '/releases/latest/download/dsh-patch-library-1.0.0.tgz'
/** 外链白名单：只放作者自己的仓库前缀，绝不做通用 URL 打开器。 */
/** 权威检测数据：来自补丁库 manifest.json 的 pristine / patched 内容哈希与 marker。 */
const PATCH_NOTICE_HASHES = {
  "agent-loop-snapshot-prompt": {
    "marker": "function compareNames(",
    "pristine": "257eb83c00a05ee068e9f4ba80ca71ab94e3a1275d24b7a0cf5038ff23dd0fd8",
    "patched": "94be7f52a5f5e5f07dfb3b8f7222644ccd7bf354ab2778c9071d9da89af6eb9b"
  },
  "llm-pi-ai-system-prompt": {
    "marker": "PI_AI_JOIN_PREFIX_SYSTEM",
    "pristine": "76911a5d9e7aa94ea3e02a3e4507e41c5edc2e5390f50e916b6e06413a1b8dc8",
    "patched": "31cc5bd444dfbe2c69524a80c2057501de80d5d56db0155a6160537ddbe9bb75"
  },
  "dsh-llm-writable-request": {
    "marker": "DSH_LLM_WRITABLE_REQUEST",
    "pristine": "f54d86572d4c0e8d9348cdc65e4c4684a4956a91162815d3c52ee7c0c58225ed",
    "patched": "616c80207e512e3f72979d09d88450dc474237e155b5ae4f5820699412dce508"
  },
  "compaction-pruner": {
    "marker": "PRUNE_ARG_MARKER_OPEN",
    "pristine": "c057a2c076e6e28549d140daf74eb232bf3c2f8a4687beab7766d0975d431a81",
    "patched": "07d5f03e140ee7b331b1600910e94b14c8781ff1d92cace4014e7448cef9f86e"
  },
  "ui-renderer-turntail": {
    "marker": "const electAll = slotKey === \"conversation.chat.turnTail\"",
    "pristine": "859d0a187e436d682c71d18f0266d588f923d7e1628157ad73000f99a377d151",
    "patched": "b53231db8e17ff9dc704ae92a6fbcec906daaf6852305db82ff1bade5237b711"
  },
  "ui-sidebar-wrap": {
    "marker": "flex-wrap:wrap",
    "pristine": "3dae1a20efda7b5f04688bf59bab65cc05a5238d58dcb437fdd430f92e6d9a93",
    "patched": "135157e12645ce30a30779a179c3865776cf5a1e81be9a8082bdba34f7abe82f"
  },
  "session-format-v1-to-v2": {
    "marker": "legacyInterruptedTurnRestart",
    "pristine": "23950e7d0366d1bf5f46c9db69cbbfc64c0cfaab786147bdd40d044cefc74584",
    "patched": "690d839c4479d7aa3af3f34103496db304110fd21b661925b73f5c1329c7a4b6"
  },
  "session-persistence-jsonl": {
    "marker": "legacyInterruptedTurnRestart",
    "pristine": "b067a35a421d5a5313b1e197a00bcc829d8d6921d2829503d4604c13e226fd64",
    "patched": "23b244f0998821fcd1cf4bc1d61e2e0a20911e159da75bbf2687dd94cde1cb26"
  },
  "mcp-client": {
    "marker": "synced incrementally",
    "pristine": "45d018fc0d57b4efbe950bca6e02adc2765e8b7aa74f7cf322f7267c1511d6e5",
    "patched": "ba44d388f2e63e140cf5bf482a8dccb4430e60c14624aa4dd5c5ec2304ae4943"
  },
  "pi-ai-max-tokens-floor": {
    "marker": "MAX_TOKENS_FLOOR",
    "pristine": "1caf860e028e22639578aba3ec8b79e5be9650c27bd3f19471c78502976555f3",
    "patched": "61262f85ee9da402609aa263b730a2e51351a5e23e42e9706c7afa1a40c5c29e"
  }
}

const LINK_LOCAL_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/

/** 本插件的状态目录（只放自己的文件，绝不碰 DSH 配置）。 */
function patchNoticeStateDir () {
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home !== '') return join(home, 'context-reclaim')
  const appData = process.env.APPDATA
  if (typeof appData === 'string' && appData !== '') return join(appData, 'dsh-desktop', 'harness', 'context-reclaim')
  return null
}

/** 「不再提醒」标记的落点。 */
function patchNoticeStateFile () {
  const dir = patchNoticeStateDir()
  return dir === null ? null : join(dir, 'patch-notice.json')
}

/** 读「不再提醒」标记；任何异常都当没关。 */
/** 读「不再提醒」状态：既兼容老的 {dismissed:true}，也支持按补丁 id 记的 {dismissedIds:[…]}。 */
function readPatchNoticeState () {
  const file = patchNoticeStateFile()
  const empty = { dismissed: false, dismissedIds: [] }
  if (file === null) return empty
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const ids = Array.isArray(raw?.dismissedIds) ? raw.dismissedIds.filter((x) => typeof x === 'string') : []
    return { dismissed: raw?.dismissed === true, dismissedIds: ids }
  } catch { return empty }
}

/** 落「不再提醒」标记；写不了就算了，绝不影响插件其余功能。 */
/**
 * @param dismissed - true 表示「不再提醒」（把**当前已知**的补丁 id 全部记下）。
 * @param ids - 当前已知要提醒的 id 列表。
 */
function writePatchNoticeState (dismissed, ids) {
  const file = patchNoticeStateFile()
  if (file === null) return false
  try {
    const prev = readPatchNoticeState()
    const next = dismissed === true
      ? { dismissed: true, dismissedIds: Array.isArray(ids) ? ids.slice() : prev.dismissedIds }
      : { dismissed: false, dismissedIds: [] }
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ ...next, at: new Date().toISOString() }, null, 2) + '\n', 'utf8')
    return true
  } catch { return false }
}

/** 探测每条目标：文件在不在 + 旁边有没有 `.orig*` 备份（与上面的体检同一判据）。 */
/** 把一条目标探测成 verdict/signal（三级判据，与启动体检同一套数据）。 */
function detectPatchNoticeTarget (target) {
  const known = PATCH_NOTICE_HASHES[target.id] ?? null
  const out = {
    id: target.id,
    title: target.title ?? target.label,
    pkg: target.pkgFull ?? target.pkg,
    file: target.file.join('/'),
    tier: target.tier ?? null,
    whyZh: target.whyZh ?? null,
    whyEn: target.whyEn ?? null,
    found: false, verdict: 'unknown', signal: 'none'
  }
  const crypto = process.getBuiltinModule?.('node:crypto')
  if (crypto === null || crypto === undefined) return out
  for (const dir of patchPackageDirs(target.pkg, target.scope)) {
    const file = join(dir, ...target.file)
    let text = null
    try {
      if (existsSync(file) !== true) continue
      text = readFileSync(file, 'utf8')
      out.found = true
    } catch { continue }
    const sha = crypto.createHash('sha256').update(text, 'utf8').digest('hex')
    if (known !== null && sha === known.patched) { out.verdict = 'applied'; out.signal = 'sha'; break }
    if (known !== null && sha === known.pristine) { out.verdict = 'missing'; out.signal = 'sha'; break }
    if (known !== null && text.includes(known.marker)) { out.verdict = 'applied'; out.signal = 'marker'; break }
    out.verdict = 'unknown'; out.signal = 'none'
    break
  }
  return out
}

/** 本插件自己受益的那几条。 */
function detectPatchNoticeItems () {
  return PATCH_NOTICE_TARGETS.map((target) => detectPatchNoticeTarget({
    ...target,
    pkgFull: target.pkg.startsWith('@') ? target.pkg : '@deepseek-ai/' + target.pkg
  }))
}

/** 其余官方补丁（不属于本插件，但列出来保证「不漏」）。 */
function detectOtherPatchNoticeItems () {
  const owned = new Set(PATCH_NOTICE_TARGETS.map((t) => t.id))
  return OFFICIAL_PATCH_TARGETS
    .filter((t) => owned.has(t.id) !== true)
    .map((t) => detectPatchNoticeTarget({
      id: t.id,
      title: t.label,
      pkg: t.pkg,
      scope: t.scope,
      file: t.file,
      pkgFull: t.scope === undefined ? '@deepseek-ai/' + t.pkg : t.scope + '/' + t.pkg
    }))
}


/** 读一个小 JSON 请求体。 */
async function patchNoticeBody (req) {
  const chunks = []
  let size = 0
  try {
    for await (const chunk of req) {
      size += chunk.length
      if (size > 64 * 1024) return null
      chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    return text === '' ? null : JSON.parse(text)
  } catch { return null }
}

/** 把本插件的补丁状态与操作挂到宿主 webServer 上（拿不到就静默跳过）。 */
function installPatchNotice (ctx, viaInject) {
  const webserver = ctx.get?.('webServer')
  /* webServer 刻意**不**写进 inject：cordis 里声明什么就是必需，真声明了在
     没有 web 服务的部署里会把整个插件停掉。这里改用 ctx.inject([...]) 的
     可选形态 —— 拿得到才注册路由，拿不到就只是没有弹窗，其余功能照旧。 */
  if ((webserver === undefined || webserver === null) && viaInject !== true && typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (sub) => { try { installPatchNotice(sub, true) } catch { /* ignore */ } })
      return
    } catch { /* 落到下面的诊断 */ }
  }
  if (webserver === undefined || webserver === null) {
    try { console.error('[reclaim/patch-notice] webServer 拿不到 ⇒ 不注册路由') } catch { /* ignore */ }
    return
  }
  const childProcess = process.getBuiltinModule?.('node:child_process')
  const send = (res, status, body) => {
    try {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    } catch { /* ignore */ }
  }
  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/dsh-context-reclaim/patch-notice' && req.method === 'GET') {
      send(res, 200, {
        ok: true,
        plugin: 'dsh-context-reclaim',
        dismissed: readPatchNoticeState().dismissed,
        dismissedIds: readPatchNoticeState().dismissedIds,
        patchLibrary: PATCHLIB_REPO,
        download: PATCHLIB_TGZ,
        items: detectPatchNoticeItems(),
        others: detectOtherPatchNoticeItems(),
        stateFile: patchNoticeStateFile()
      })
      return
    }
    if (url.pathname === '/dsh-context-reclaim/patch-notice/dismiss' && req.method === 'POST') {
      const body = await patchNoticeBody(req)
      send(res, 200, { ok: writePatchNoticeState(body?.dismissed === true, body?.ids) })
      return
    }
    if (url.pathname === '/dsh-context-reclaim/patch-notice/open' && req.method === 'POST') {
      /* 同源闸：带了 Origin 又不是本机来源的，一律拒绝（防网页 CSRF 打开浏览器）。 */
      const origin = req.headers?.origin
      if (typeof origin === 'string' && origin !== '' && LINK_LOCAL_RE.test(origin) !== true) {
        send(res, 200, { ok: false, error: '跨源请求被拒绝' })
        return
      }
      const body = await patchNoticeBody(req)
      const target = typeof body?.url === 'string' ? body.url : ''
      /* 只认两个写死的地址 —— 不做前缀匹配，也不把它交给 shell 去拼。 */
      if (target !== PATCHLIB_REPO && target !== PATCHLIB_TGZ) {
        send(res, 200, { ok: false, error: '不在白名单里的链接' })
        return
      }
      try {
        if (childProcess !== null && childProcess !== undefined) {
          if (process.platform === 'win32') {
            childProcess.spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore' }).unref()
          } else if (process.platform === 'darwin') {
            childProcess.spawn('open', [target], { detached: true, stdio: 'ignore' }).unref()
          } else {
            childProcess.spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref()
          }
          send(res, 200, { ok: true, url: target })
          return
        }
        send(res, 200, { ok: false, url: target, error: 'child_process 不可用' })
      } catch (error) {
        send(res, 200, { ok: false, url: target, error: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    send(res, 404, { ok: false, error: 'not found' })
  }
  ctx.effect(() => webserver.register({
    kind: 'prefix',
    path: '/dsh-context-reclaim',
    handler: (req, res) => handler(req, res)
  }), 'dsh-context-reclaim: patch notice routes')
}
