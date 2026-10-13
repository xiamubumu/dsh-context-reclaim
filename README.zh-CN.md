<div align="center">

# dsh-context-reclaim

**在工具结果进入模型之前，就把上下文回收掉。**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-1.5-8a2be2.svg)](#兼容性)
[![Platform](https://img.shields.io/badge/platform-desktop%20%7C%20web-lightgrey.svg)](#兼容性)

[English](README.md) · **简体中文**

</div>

---

## 这是什么

DSH 会话的上下文不是被对话撑爆的，是被**工具结果**撑爆的：一次 `read` 几百行、一次 `pwsh` 一大片日志、一份系统提示每轮原样重复。这些内容一旦进了历史，就只能靠压缩器事后动刀——而压缩要重写已提交的历史，会把服务端前缀缓存整段打掉，越压越贵。

`dsh-context-reclaim` 换了个位置：**在工具结果被 append 进历史之前**就处理掉，并且从不改写已经提交的内容。所以前缀缓存永远不会因为本插件而失效。

它挂在 5 个接缝上：

| 接缝 | 做什么 | 默认 |
|---|---|---|
| `tools/post-execute` | 工具结果一产生就净化 + 按内容类型有界化，截断处插入取回指针 | 开 |
| `system-prompt/assemble` | 折叠工具定义面、稳定前缀段顺序、截断超长描述行 | 开 |
| `tools/pre-execute` | 重复编辑拦截（同一个文件同一段内容改第二次直接拦下） | 开 |
| `session/event` | 摘要完整性审计（压缩摘要缺段时报警） | 开 |
| `llm/stream` | 每请求一行成本归因，打出 route / prompt / 缓存命中 / 输出 | 开 |

---

## 1. 工具结果净化与有界化

这是核心。每次工具调用返回时，插件先做**无损净化**，再做**有界化**。

### 无损净化

折叠 ANSI 转义序列、去掉行尾空白、统一 CR。这一步是纯净化，不丢任何信息。

只有在内容**同时**满足两个门槛时才动手：长度 ≥ 32 字符，且净化后缩减比例 ≥ 0.2%。小结果根本不碰。

关掉它：`config.noise = false` 或环境变量 `DSH_RECLAIM_NOISE=0`。

### 按内容类型有界化

不同类型的工具结果，容忍度完全不同。插件把工具分成三类：

| 类别 | 覆盖的工具 | 头 / 尾保留 | 单行上限 | 总字符上限 |
|---|---|---|---|---|
| **只读** | `read` `grep` `glob` `codegraph_*` `lsp_*` | 80 行 / 12 行 | 512 | 160 |
| **有副作用** | `pwsh` `bash` `docker_*` `job_output` | 40 行 / 40 行 | 1024 | 256 |
| **保真** | `web_fetch` `web_search` `knowledge_*` `read_image` `pilot_snapshot` | 原样不动 | — | — |

认不出来的工具按**保真**处理——宁可不省，也不误伤。

被截断的地方会插入一个取回指针，告诉你原文还有多少、可以用什么方式取回，而不是无声无息地丢掉。

有界化的触发门槛是「能省下超过 5%」；省得不多就不动。

关掉它：`config.bounded = false` 或环境变量 `DSH_RECLAIM_BOUNDED=0`。

> **关于超大结果**：超过 `config.maxInlineBytes`（默认 50000）的内容会交给 spill 机制落盘。这需要你的 profile 里装了 spill 插件——没有装的话，这个阈值不生效，超限内容原样通过。

### 保真白名单

三类工具的名单都可以在配置里整表替换：

```yaml
- id: reclaim
  config:
    readOnlyTools: ['read', 'grep', 'glob']      # 整表替换，不是追加
    sideEffectTools: ['pwsh', 'bash']
    faithfulTools: ['web_fetch', 'web_search']
```

注意这是**整表替换**，不是逐字段合并——只写 `headLines` 会丢掉字符上限。要么整张表写全，要么别写。

---

## 2. 工具定义面折叠

每个会话一开始，DSH 会把所有可用工具的完整定义（名字、描述、参数 schema）塞进系统提示。装了几十个插件之后，这一块能占到很大比例，而其中大部分工具在这一轮里根本不会被用到。

插件默认**折叠**这部分：保留最常用的若干个完整定义，其余压成一行清单（只有名字 + 一句话描述，没有参数 schema）。

**被折叠的工具照样能调。** 一行清单只是把 schema 从提示里拿掉了 —— 工具本身仍然注册在宿主上，所以模型依然可以用 `search_tools` 找到它、用 `invoke_tool` 直接调用，或用 `load_plugin` 让它重新常驻。**没有 `load_tools` 这个工具**，配对的是 `search_tools` + `invoke_tool`。如果你更希望每个 schema 都留在提示里，就关掉折叠（见下一行）。

关掉它：`config.foldTools = false` 或环境变量 `DSH_RECLAIM_TOOL_FOLD=0`。

---

## 3. 前缀稳定化

服务端前缀缓存只在**前缀逐字节不变**时才命中。而系统提示里天生带一堆每轮都在变的东西：token 计数、时间戳、会话序号。

插件默认抹平这些易变数字，并重排段落顺序让稳定的段排在前面、易变的段排在后面。每次重排会在日志里打一行 `[reclaim/section-order]`，告诉你哪几段被移动了。

---

## 4. 超长描述行截断

系统提示里偶尔会有单行特别长的描述（某些插件写的长注释）。超过阈值（`config` 里没有暴露，环境变量 `DSH_RECLAIM_PROMPT_LINE_MAX`，默认 120 字符）的行会被截断，并在日志打出被截断的行号。

---

## 5. 重复编辑拦截

同一个文件、同一段内容，如果模型连续两次发起完全一样的修改，第二次会被拦下并返回说明——这种调用几乎必然是无意义的重复，白白烧一次往返。

日志行：`[reclaim/dedup-deny]`。

关掉它：环境变量 `DSH_RECLAIM_DEDUP_DENY=0`。

---

## 6. 摘要完整性审计

压缩器生成的摘要如果被输出预算截断，会**静默**变短——你不会收到任何提示，只是下一轮开始上下文就缺了一块。

插件在每次压缩后审计摘要是否包含应有的结构段，缺了就报警：

```
[reclaim/summary-audit] ⚠️ 摘要缺 3/8 段
```

它**只报警，不改摘要**。真正防止摘要被截断的是 [`dsh-aux-degrade`](#-与-dsh-aux-degrade上下文治理两件套--请务必一起安装)，见下面的联动章节。

---

## 7. 成本归因

每个请求结束打一行：

```
[reclaim/usage] route=aux prompt=12043 hit=11890 miss=153 out=204 purpose=compaction
```

`hit` / `miss` 是前缀缓存的命中与未命中字符数，`purpose` 是这次调用的用途（如果有）。缓存被打破时会另外打一行 `[reclaim/cache-break]`。

这个日志是排查「为什么我的缓存命中率不高」最快的入口。

---

## 8. 接管「可写请求」——不需要给 `dsh-llm` 打补丁

**这一段就是「装完插件就不必再改文件」的原因。**

原版 `@deepseek-ai/dsh@0.1.5-rc.2` 里，主线路的对话请求在进入 `@deepseek-ai/dsh-llm` 之前就已经被宿主**深度冻结**。它的入口长这样：

```js
stream(options) { return this.streamWithRegistration(options) }
streamWithRegistration(options, prepared) {
  return this.ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(options, prepared))
}
```

瀑布的 `next` 是**忽略参数**的闭包，适配器读的是外层那个 `options`。所以挂在 `llm/stream` 上的插件只能**看**这个请求，改不了它——往冻结对象上写会抛错，把新对象传给 `next(...)` 则完全没有效果。桌面版 DSH 一直随包带一个 **`dsh-llm/lib/index.js` 的文件补丁**，全部内容就六行：把冻结请求浅拷贝一份、连 `messages` 数组一起拷、用 `markAgentLoopRequest` 重新打标记，再把副本交给瀑布。

**1.0.0 起，本插件在插件层做了同一件事。** 它在加载时把 `ctx.llm.streamWithRegistration` 包一层：

* 请求**冻结** → 浅拷贝 + 拷 `messages` 数组 + 逐个拷消息对象，再用**宿主自己那份** `dsh-llm` 模块里的 `markAgentLoopRequest` 重新打标记，副本才进 `llm/stream`；
* 请求**没冻结**（宿主已经打过补丁）→ 原样透传，逐字节不变，行为零变化；
* 出现任何意外 → 记一条日志后原样透传。本插件绝不会把一个能用的会话弄坏。

因此，**一个补丁都没打的原版运行环境，不碰任何文件就能拿到可写请求。** 在一个完全零补丁的真实运行时上（`dsh --profile headless`，真实请求，`[reclaim/wire]` 行）实测 A/B：

```
# 接管开启（默认）
[reclaim/wire] 入口探测：messages=5 条 · options 冻结=false · messages 冻结=false · route=deepseek-official|deepseek-flash|main|ba8a6419
# 接管关闭（DSH_RECLAIM_WRITABLE_REQUEST=0）
[reclaim/wire] 入口探测：messages=5 条 · options 冻结=true  · messages 冻结=true  · route=deepseek-official|deepseek-flash|main|d7d22e75
```

用 `DSH_RECLAIM_WRITABLE_REQUEST=0` 可以关掉它。启动日志会把实际情况说清楚：

```
[reclaim/writable] 已接管 llm.streamWithRegistration：冻结的主请求先浅拷贝再进 llm/stream ⇒ 不再需要给官方 dsh-llm 打文件补丁（可用 dsh-llm 副本 2 份）
```

### 它怎么找到「宿主自己那一份」模块

`markAgentLoopRequest` 往一个 `WeakSet` 里写，而这个集合**只存在于某一个模块实例内部**；Node 对每一个不同的模块 URL 都会造一份独立实例。用别的实例去标记等于白标：别的插件在那个集合里查不到你的对象。所以本插件：

1. 从 `process.argv` 推导候选位置（真正的 `…/@deepseek-ai/dsh/lib/bin.js`——桌面外壳里它在 `argv[2]`，不是 `argv[1]`），再用 `createRequire` 从宿主入口解析一次，再补上 `$DSH_HOME/profiles{/*}/node_modules` 这两条软链接拼法；
2. 逐个 import，并对着**当前这个真实请求**做**往返自检**：第一个 `isAgentLoopRequest(options)` 返回 `true` 的，就是宿主自己那份，用它；
3. 一个都不匹配时，打一次警告，然后仍然用第一份接管。**这条限制如实说：** 这种情况下上下文改写照常生效，但 `@deepseek-ai/dsh-session-title` 可能不再自动给会话起标题，因为它查的是同一个 `WeakSet`。该现象在某种 npm 安装布局上出现过，桌面端布局上没有。DSH 内部除它之外没有别的消费者。

如果检测到 `invariants` 服务存在（`dsh-agent-loop` 的「循环请求必须冻结」断言），本插件会自动**跳过接管**——否则会话会被断言中断。现有 1.5 的任何 profile 都没有加载它，但真出现了我们宁可让路，也不弄断你的会话。

### 启动时的「官方补丁体检」——只报告，绝不动手

插件加载时会扫一遍它能定位到的官方补丁目标，然后打**且只打一行**：

```
[reclaim/patch-check] 官方补丁体检（只读，本插件不会自动改官方文件）：7 个目标里未检测到 7 条 —— dsh-llm 可写请求、agent-loop 快照回收 / 系统提示收敛、…
```

它刻意做成**只读**。本插件不是补丁器：改动你 DSH 安装目录里的文件，是你的决定，不该是「装了个插件」的副作用。判据是启发式（找补丁脚本在文件旁边留下的 `*.orig` 备份），所以说的是「未检测到」而不是「没打」；一旦推导不出你的安装布局，它就完全闭嘴。用 `DSH_RECLAIM_PATCH_CHECK=0` 可以关掉。

真有想打又没打上的，别去找脚本——**把这件事交给你的 agent。** 本插件包里的 `tutorial-install-and-official-patches.zh-CN.md`（英文版 `tutorial-install-and-official-patches.md`）有一段可以直接整段复制的提示词，写清了每条补丁改哪个文件、验收标准是什么；你的 agent 读完就在你自己的机器上打。**推荐走这条路**，因为你的 agent 看得到你真实的安装目录，而写在插件里的硬编码脚本看不到。

### 其余官方补丁：插件能替代什么、不能替代什么

如实写明，因为装上这四个插件**并不等于**其余文件补丁就不需要了：

| 官方 1.5 文件补丁 | 改的哪里 | 能否用插件替代 |
|---|---|---|
| `@deepseek-ai/dsh-llm` — 可写请求 | `lib/index.js` | ✅ **能——本插件已经做了，见上** |
| `@deepseek-ai/dsh-client-ui-sidebar` — 页脚槽位加 `flex-wrap` | `lib/lib-client.js` | ✅ 能（客户端插件注入 CSS 即可）；本项目未随包提供 |
| `@deepseek-ai/dsh-agent-loop` — 运行时快照回收、系统提示收敛 | `lib/index.js` | ❌ 不能——要改 agent-loop 私有的投影类与提交点 |
| `@deepseek-ai/dsh-llm-pi-ai` — `splitSystemPrompt` 收集开头全部 system | `lib/index.js` | ❌ 不能，而且没有上面那条 agent-loop 补丁时它没有意义 |
| `@deepseek-ai/dsh-compaction-tool-result-pruner` — 结果剪枝 + 承重守卫 | `lib/index.js` | ❌ 不能——宿主直接 `new` 那个导出的类，没有注册接缝 |
| `@deepseek-ai/dsh-client-ui-renderer` — `conversation.chat.turnTail` 链式选举 | `lib/client.js` | ❌ 不能——必须改官方客户端 bundle 本身 |
| `@deepseek-ai/dsh-session-format-v1-to-v2` — 修 `turn/start` | `lib/index.js` | ❌ 不能——跑在会话恢复路径内部 |
| `@deepseek-ai/dsh-session-persistence-jsonl` — 同上，持久化侧 | `lib/worker.cjs` | ❌ 不能——跑在 worker 线程里 |
| `@earendil-works/pi-ai` — `max_tokens` 下界 | `dist/api/simple-options.js` | ❌ 不能——第三方 dist，其 ESM 命名空间只读 |

一句话总结：**这四个插件原本必须依赖的那一条补丁已经不需要了**；剩下几条改的是 DSH 自己的机器行为，属于可选增强。真要打，做法（含可以直接整段交给你的 agent 执行的提示词）见本仓库内的 `tutorial-install-and-official-patches.zh-CN.md`。

---

## 配置

配置文件是 profile 的 `cordis.patch.yml`：

```yaml
- id: reclaim
  config:
    enabled: true
    noise: true
    bounded: true
    stripLines: false
    noOpGuardRatio: 0.05
    maxInlineBytes: 50000
    attribution: true
    trimSections: false
    foldTools: true
    activePlugins: []
```

| 键 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关（`!== false` 即视为开） |
| `noise` | boolean | `true` | 无损净化（ANSI / 行尾空白 / CR） |
| `bounded` | boolean | `true` | 按内容类型有界化 + 取回指针 |
| `stripLines` | boolean | `false` | 剥离行号前缀 |
| `noOpGuardRatio` | number | `0.05` | 有界化「省得够多才动手」的门槛，5% |
| `maxInlineBytes` | number | `50000` | 超过这个字节数交给 spill（需装 spill 插件） |
| `readOnlyTools` | string[] | 见上表 | 只读类工具名单，**整表替换** |
| `sideEffectTools` | string[] | 见上表 | 有副作用类工具名单，**整表替换** |
| `faithfulTools` | string[] | 见上表 | 保真类工具名单，**整表替换** |
| `attribution` | boolean | `true` | 打 `[reclaim/usage]` 归因行 |
| `trimSections` | boolean | `false` | 段落收纳（注意：实际闸门是环境变量 `DSH_RECLAIM_SECTION_TRIM`，见下） |
| `foldTools` | boolean | `true` | 折叠工具定义面 |
| `activePlugins` | string[] | `[]` | 参与段归属计算的插件名单 |

> ⚠️ `trimSections` 这个配置项的取值不会真正开门——代码里的闸门只认环境变量 `DSH_RECLAIM_SECTION_TRIM`，而且还需要 `activePlugins` 非空。这一条在旧文档里说法有误，这里如实写出。

### 常用环境变量

完整的环境变量有 40 多个，覆盖每一处内部阈值。按功能分组，最常用的这些：

| 变量 | 默认 | 作用 |
|---|---|---|
| `DSH_RECLAIM_NOISE` | `1` | 设 `0` 关无损净化 |
| `DSH_RECLAIM_BOUNDED` | `1` | 设 `0` 关有界化 |
| `DSH_RECLAIM_STRIP_LINES` | `0` | 设 `1` 剥离行号 |
| `DSH_RECLAIM_TOOL_FOLD` | `1` | 设 `0` 关工具定义面折叠 |
| `DSH_RECLAIM_PROMPT_LINE_MAX` | `120` | 系统提示单行截断阈值 |
| `DSH_RECLAIM_DEDUP_DENY` | `1` | 设 `0` 关重复编辑拦截 |
| `DSH_RECLAIM_SECTION_TRIM` | `0` | 设 `1` 开段落收纳（配合 `activePlugins`） |
| `DSH_RECLAIM_STABILIZE` | `1` | 设 `0` 关前缀稳定化 |
| `DSH_RECLAIM_WRITABLE_REQUEST` | `1` | 设 `0` 停止接管 `llm.streamWithRegistration`（见第 8 节）；关掉它之后才需要官方 `dsh-llm` 补丁 |
| `DSH_RECLAIM_PATCH_CHECK` | `1` | 设 `0` 关闭启动时那行「官方补丁体检」提示 |
| `DSH_RECLAIM_LOG` | `1` | 设 `0` 关本插件的日志输出 |
| `DSH_RECLAIM_DUMP_SYSTEM` | `0` | 设 `1` 把组装好的系统提示转储到临时目录，用于排查 |

其余阈值类变量（采样行数、预算观测、污染检测窗口、归档上限、推理剥离等）在源码顶部有逐条注释。

---

## 安装

### 从 DSH 插件市场

在 DSH 的插件市场里搜 `dsh-context-reclaim`，点安装。

### 从 GitHub

```bash
dsh plugin --profile web add github:xiamubumu/dsh-context-reclaim
```

### 从 npm

```bash
dsh plugin --profile web add dsh-context-reclaim
```

装完**需要重启 DSH**——宿主侧插件只在 DSH 启动时装载。

本插件**没有任何运行时依赖**，`peerDependencies` 只声明官方的 `@deepseek-ai/dsh-tools`。安装不会往你的 profile 里塞任何第三方包。

---

## 兼容性

| | |
|---|---|
| **DSH 内核** | **1.5 系列**（`0.1.5-rc.2` ≤ 版本 < `0.2.0`）—— `package.json` 的 `engines.dsh` 就是写的这个范围。后续 DSH 版本会跟进 |
| **形态** | **桌面版 ✅ · 网页版 ✅** —— 准确地说，**只要跑的是 DSH 就支持**，本插件不依赖任何桌面专属能力 |
| **操作系统** | Windows · macOS · Linux |
| **Node 语法** | 20 及以上（这是源码用到的语法下限，**不需要你自己装 Node**，DSH 自带运行时） |

本插件对 DSH 内核版本有范围的硬要求：`engines.dsh` 声明为 `>=0.1.5-rc.2 <0.2.0`，插件市场会据此判定兼容性。DSH 升级到 `0.2.0` 之后本插件会被判为不兼容，届时会发布新版本。

---

**原版（一个补丁都不打）的 DSH 被完整支持。** 上下文回收需要一个*可写*请求，而 1.0.0 起本插件自己就能造出来——见第 8 节。它工作不需要你改任何文件。其余官方补丁改的是 DSH 自己的机器行为，没法做成插件；每条补丁做什么、插件到底能不能替代，第 8 节的表格里如实列了。以后你补打了补丁也不会与本插件冲突：请求到达时若已经不冻结，就原样透传。

---

## 🔗 与其它插件的联动

### 🔗 与 `dsh-aux-degrade`（上下文治理两件套）—— 请务必一起安装

`dsh-context-reclaim` 与 [`dsh-aux-degrade`](https://github.com/xiamubumu/dsh-aux-degrade) 是同一套「上下文治理」方案的两半。**强烈建议同时安装，这是本插件最重要的联动关系。**

**① 它们共享同一个路由口径。** 两个插件都用同一个判据区分「主对话调用」与「辅助调用」：

```
tools.length > 0 ? 'main' : 'aux'
```

reclaim 用它给成本归因打 `route=` 标签，aux-degrade 用它决定要不要给这次调用降思考强度。**口径必须一致**，否则两个插件对「哪一次调用算辅助调用」的判断会打架，一边省着、一边漏着。

**② 它们的分工。** reclaim 管**内容**（工具结果进历史前的净化与有界化、工具定义面折叠、前缀稳定化）；aux-degrade 管**调用**（把压缩摘要 / 会话标题这类辅助调用的思考强度降到 `off`，并给压缩指令追加两节保真要求）。

**③ 缺了对方会怎样。**

| 只装 | 结果 |
|---|---|
| 只有 reclaim | 一切照常工作。但辅助调用仍会烧满思考预算，压缩摘要仍可能被输出顶截断——reclaim 只会在日志里打 `[reclaim/summary-audit] ⚠️ 摘要缺 N/8 段` 提醒你，**它自己不会去改摘要**（这是有意的：reclaim 不碰已提交内容） |
| 只有 aux-degrade | 一切照常工作。但工具结果不会被净化与有界化，长结果原样进历史 |

**④ 两者互不依赖。** reclaim 源码里**没有任何 `import` / `require`**，aux-degrade 只 import 官方的 `@deepseek-ai/schemastery`。它们不互相探测、不互相引用——**任何一个都能单独安装并正常工作**，只是覆盖度不同。这也是为什么它们是两个仓库而不是一个。

**⑤ 一个实用细节。** 如果你打开 reclaim 的 `[reclaim/usage]` 归因日志，会看到里面有个 `purpose=` 字段。这个字段就是用来诊断「**哪一类辅助调用没被 aux-degrade 降到 off**」的——它是一次只读诊断，不改任何行为。看到 `purpose=unknown` 或某个没见过的 purpose 时，那通常意味着有一条辅助调用路径绕过了降级判据。

**⑥ 一句话。** 装了 reclaim 不装 aux-degrade，你会看到问题但修不掉；装了 aux-degrade 不装 reclaim，你的辅助调用省了但工具结果没省。两个一起装，上下文治理才是完整的。

### 🔗 与 `dsh-capability-composer`

reclaim 内部维护一张「哪一段系统提示归谁管」的归属表（`SECTION_OWNER`），其中「可用插件」这一段归 [`dsh-capability-composer`](https://github.com/xiamubumu/dsh-capability-composer)。

也就是说：**装插件清单不该由 reclaim 来裁剪**——那是能力组合器的职责。两者同时安装时，段的收窄交给组合器执行，reclaim 只在组合器不在场时保留默认行为。

### 🔗 与 `dsh-composer-launcher`

无直接耦合。两者可以任意组合安装。

---

## FAQ

<details>
<summary><b>它会破坏我的前缀缓存吗？</b></summary>

不会。这是本插件最重要的一条设计约束：**它只在内容进入历史之前动手，从不改写已经提交的内容**。已提交部分逐字节不变，前缀缓存因此永远不会因为 reclaim 而失效。
</details>

<details>
<summary><b>它会把我的工具输出改掉吗？</b></summary>

只在超过阈值时截断，并且一定在截断处留下取回指针。净化那一层是无损的（ANSI 转义、行尾空白这类本来就不携带信息的东西）。另外有三类工具被列为「保真」，**原样通过，一个字符都不动**。
</details>

<details>
<summary><b>装完要重启吗？</b></summary>

要。宿主侧插件在 DSH 启动时装载。重启一次之后就一直生效。
</details>

<details>
<summary><b>它会往我的 profile 里装别的东西吗？</b></summary>

不会。本插件零运行时依赖，`peerDependencies` 只声明官方包，安装过程不会引入任何第三方代码。
</details>

<details>
<summary><b>我怎么知道它到底省了多少？</b></summary>

看 `[reclaim/usage]` 日志行的 `hit` / `miss` 字段，那是每请求的真实前缀缓存字符数。被截断的结果会在截断处自带说明（省了多少、怎么取回）。
</details>

<details>
<summary><b>支持网页版 DSH 吗？</b></summary>

支持。本插件是宿主侧插件，只依赖 Cordis 的通用接缝（`tools/post-execute`、`system-prompt/assemble`、`session/event`、`llm/stream`），不依赖任何 Electron 或桌面专属能力。**只要是 DSH，桌面版和网页版都能用。**
</details>

<details>
<summary><b>为什么有两个插件都叫「上下文治理」？</b></summary>

因为它们管的是两层不同的事：一个管**内容**（结果进历史前怎么处理），一个管**调用**（辅助调用花多少思考预算）。见上面的[联动章节](#-与-dsh-aux-degrade上下文治理两件套--请务必一起安装)。
</details>

---

## 仓库结构

```
dsh-context-reclaim/
├── index.js            # 全部实现（单文件，无外部依赖）
├── cordis.patch.yml    # DSH 插件清单补丁
├── package.json
├── verify.mjs          # 离线自检：node verify.mjs
├── README.md           # English
└── README.zh-CN.md     # 简体中文
```

## 自检

```bash
node verify.mjs
```

离线运行、不写盘。检查清单字段、语法、有没有混进私钥或备份文件、运行时代码里有没有写死的机器路径。

## License

[MIT](LICENSE) © 2026 夏目 ([xiamubumu](https://github.com/xiamubumu))
