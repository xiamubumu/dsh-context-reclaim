# 教程：装四个插件，以及「官方补丁」到底还要不要打

适用版本：**DSH 1.5 系列**（`0.1.5-rc.2` ≤ 版本 < `0.2.0`）。桌面版 / 网页版都适用——**只要是 DSH 就支持**。

---

## 一、先装插件（三步，不用改任何文件）

四个插件是**互相独立**的仓库，可以只装一个，也可以四个都装。

### 方式 A：从 DSH 插件市场装（推荐）

在 DSH 里打开 **设置 → 插件 → 市场**，搜索下面四个名字之一并安装：

| 插件 | 干什么的 | 建议 |
|---|---|---|
| `dsh-context-reclaim` | 上下文回收：工具结果净化/有界化、工具面折叠、前缀稳定、缓存命中率归因 | **强烈建议** |
| `dsh-aux-degrade` | 辅助模型降级：压缩类调用去 tools、给 maxTokens 兜底、保留承重内容 | 与 reclaim 成对使用 |
| `dsh-capability-composer` | 能力组合器：按场景裁剪技能/插件/工具，按需加载 | 可选 |
| `dsh-composer-launcher` | 组合器启动器：浏览器扩展桥、插件条目映射、语言跟随 | 可选（依赖的是它自己，不依赖别的插件） |

### 方式 B：从 npm / GitHub 装

```bash
npm install -g @deepseek-ai/dsh          # 如果还没装 CLI
dsh plugin --profile web add dsh-context-reclaim
dsh plugin --profile web add dsh-aux-degrade
dsh plugin --profile web add dsh-capability-composer
dsh plugin --profile web add dsh-composer-launcher
```

装完**重启 DSH**。DSH 的 bundle 机制会自动把它们登记进 profile 的 `dsh.profile.bundles`，
**不需要手改 `cordis.patch.yml`**，也不需要手填任何路径——四个插件里没有任何硬编码的安装路径。

### 装完请确认这 5 件事

1. 启动日志里出现 `[reclaim/wire]`、`[reclaim/usage]` ⇒ context-reclaim 在工作。
2. 启动日志里出现 `[reclaim/patch-check]` ⇒ 补丁体检在工作（下一节讲）。
3. 启动日志里出现 `[composer]` 开头的行、且没有 `Failed to load plugins` ⇒ capability-composer 在工作。
4. 侧边栏出现组合器入口；点击它能看到插件条目。
5. 浏览器扩展：**不装也能用**；要装的话有两条路（下一个小节）。

### 浏览器扩展：装完插件就自动装吗？

**能自动的已经自动了，不能自动的那部分老实说清楚。**

Chromium **不会**允许任何东西把扩展静默塞进你日常用的那个浏览器里 —— 这是浏览器的安全规则，不是插件没做。所以：

| 路线 | 怎么做 | 人工步骤 |
|---|---|---|
| **A. 零人工** | 组合器「标签页」行按 **拉起调试浏览器**（英文界面：*Open a browser with the extension loaded*）。插件会另起一个 Chromium 进程，用 `--load-extension` 把已暂存的扩展挂上，**并去调试端口核实真的挂上了**；如果旧配置目录不接受这些开关，它会自动换一个干净目录重试一次。 | **无** |
| **B. 装进你日常那个浏览器** | 「标签页」行按 **[打开扩展管理页]** + **[复制扩展路径]**，然后在扩展页打开「开发者模式」→「加载解压缩的扩展」→ 粘贴路径。也可以用终端：`pwsh -ExecutionPolicy Bypass -File .\install-extension.ps1`（它会列出这台机器上装了哪些浏览器并打开对应的扩展页；`-Browser edge` 可跳过询问）。 | 一次性，约 20 秒 |
| **C. 成建制部署** | Chromium 企业策略 `ExtensionSettings` / `ExtensionInstallForcelist` + 自托管已签名 CRX + HTTPS 更新清单。 | 需要管理员权限，**本仓库不提供** |

要点：

- **A 是核实过的，不是承诺。** `--load-extension` 被忽略时 Chromium **不报任何错**，所以插件每次都去调试端口查原始目标列表，确认出现的是**本扩展自己的** `background.js`；两次都失败会在返回值里把 `extensionLoaded` 如实标成 `false`，标签页那行退回用调试端口读，**不会假装成功**。
- **B 的路径由插件自己 stage**，装在 `%APPDATA%\dsh-desktop\harness\extensions\dsh-tab-bridge`（macOS / Linux 按各自平台位置），**插件装好即已生成**，不需要你去找。
- 扩展只是把「标签页」那一行填成你真实浏览器里开着的页面；**不装，插件的其它功能全都在**。
- 细节与截图见 launcher 仓库的 README「浏览器扩展」一章。

---

## 二、官方补丁：现在的答案

### 一句话结论

> **四个插件都不需要打任何官方补丁。**
> 唯一原本必须打的那条（`@deepseek-ai/dsh-llm` 可写请求），从 1.0.0 起已经由
> `dsh-context-reclaim` **在插件层自己完成**了。
> 剩下 8 条改的是 DSH 自己的机器行为，**插件替代不了**，属于**可选增强**：打了更顺，不打不影响这四个插件。

### 为什么以前必须打那条补丁

宿主把主线路的对话请求**深度冻结**之后才交给 `@deepseek-ai/dsh-llm`，而它的入口是：

```js
streamWithRegistration(options, prepared) {
  return this.ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(options, prepared))
}
```

瀑布的 `next` **忽略参数**，适配器读的是外层那个冻结的 `options`。所以插件能读、不能改。
官方补丁的全部内容就是把这六行变成「先浅拷贝成可写对象再进瀑布」。
**现在这段逻辑在 `dsh-context-reclaim` 里**，装插件即生效，一个文件都不用碰。

实测（一个**完全零补丁**的真实 1.5 运行时，真实请求）：

```
# 默认（插件接管）
[reclaim/wire] 入口探测：messages=5 条 · options 冻结=false · messages 冻结=false · route=…
# 关掉接管（DSH_RECLAIM_WRITABLE_REQUEST=0）
[reclaim/wire] 入口探测：messages=5 条 · options 冻结=true  · messages 冻结=true  · route=…
```

### 9 条官方补丁总表（如实）

| # | 补丁 | 改的文件 | 作用 | 插件能替代吗 | 要不要打 |
|---|---|---|---|---|---|
| 1 | `@deepseek-ai/dsh-llm` | `lib/index.js` | 让 `llm/stream` 拿到**可写**请求 | ✅ **能，已内置** | **不用打** |
| 2 | `@deepseek-ai/dsh-client-ui-sidebar` | `lib/lib-client.js` | 侧栏页脚槽位加 `flex-wrap`（纯样式） | ✅ 能（客户端插件注入 CSS） | 可打可不打 |
| 3 | `@deepseek-ai/dsh-agent-loop` | `lib/index.js` | 运行时快照每轮回收 + 系统提示收敛到 1 条 | ❌ 不能（要改私有投影类与提交点） | 会话变慢再打 |
| 4 | `@deepseek-ai/dsh-llm-pi-ai` | `lib/index.js` | `splitSystemPrompt` 收集开头全部 system | ❌ 不能，且**没有 3 就没意义** | 跟 3 一启动 |
| 5 | `@deepseek-ai/dsh-compaction-tool-result-pruner` | `lib/index.js` | 压缩期结果剪枝 + 承重 token 守卫 | ❌ 不能（宿主直接 `new` 那个类，无注册接缝） | 想要更省的压缩再打 |
| 6 | `@deepseek-ai/dsh-client-ui-renderer` | `lib/client.js` | `conversation.chat.turnTail` 链式选举（交付行排序） | ❌ 不能（必须改官方客户端 bundle） | 需要多插件同时占 turnTail 才打 |
| 7 | `@deepseek-ai/dsh-session-format-v1-to-v2` | `lib/index.js` | 修 `turn/start N does not open expected turn N-1` | ❌ 不能（跑在会话恢复路径内部） | **遇到会话打不开就打** |
| 8 | `@deepseek-ai/dsh-session-persistence-jsonl` | `lib/worker.cjs` | 同上，持久化侧（worker 线程） | ❌ 不能 | 跟 7 一起 |
| 9 | `@earendil-works/pi-ai` | `dist/api/simple-options.js` | `max_tokens` 被钳到 1 ⇒ 引入 `FLOOR=1024` | ❌ 不能（第三方 dist，ESM 命名空间只读） | 出现「输出只有一两个字」再打 |

> 关于第 9 条：读环境变量 `DSH_PI_AI_MAX_TOKENS_FLOOR`，设 `0` 即恢复上游行为。

### 启动时的「补丁体检」

`dsh-context-reclaim` 每次加载会打**且只打一行**：

```
[reclaim/patch-check] 官方补丁体检（只读，本插件不会自动改官方文件）：7 个目标里未检测到 7 条 —— …
```

它**只读、不自动动手**。改动 DSH 安装目录里的文件是你的决定，不该是「装了个插件」的副作用。
判据是启发式（找补丁脚本在文件旁留下的 `*.orig` 备份），所以说的是「未检测到」而不是「没打」；
推导不出安装布局时它完全闭嘴。用 `DSH_RECLAIM_PATCH_CHECK=0` 关掉。

**看到这行不用慌**：它列出的东西一件都不影响四个插件工作。

---

## 三、想打补丁？让你的 agent 来打（推荐）

不要让插件替你改官方文件，也不要照抄一段写死路径的脚本。
**把下面这段整段复制给你的 agent**（DSH / Claude Code / Codex 都行）。它会先看清你的机器，再动手。

> 说明：本机如果本来就有一份「专项补丁库」（里面有 `manifest.json` 和 `restore.ps1`），
> 把它的路径一起告诉 agent，它会优先走那条路（复制现成补丁，最省事、最不容易出错）。

### 📋 可直接复制的提示词（中文）

```
请你帮我在本机给 DSH 打「官方 1.5 文件补丁」。规则如下，必须严格遵守：

【第 0 步：先摸清环境，不要先动手】
1. 找到本机 DSH 的安装根目录（通常是 <某个盘>\...\resources\app\，
   里面应能看到 node_modules\@deepseek-ai\dsh\lib\bin.js）。
   如果找不到，直接停下来问我，不要猜。
2. 找到正在使用的 DSH_HOME（默认 %APPDATA%\dsh-desktop\harness）。
3. 检查本机有没有「专项补丁库」：一个含 manifest.json 与 restore.ps1 的目录。
   我如果给了你路径就按我的；没给就先问我有没有。有的话优先用它（见第 3 节）。

【第 1 步：安全红线，任何情况下不许越线】
- 每改一个文件，先把它备份成同目录下的 <原文件名>.orig（已存在就 .orig-2，不要覆盖旧备份）。
- 只改 [DSH 安装根]\node_modules\ 下面那些包的 .js / .cjs 文件。
- 绝对不许改 DSH_HOME（%APPDATA% 下的用户数据、会话、配置、凭据）。
- 不许删除任何文件；不许改 package.json 的版本号。
- 每改一个文件，立刻用你的 node 跑 `node --check <文件>`，语法不过就立刻回滚这一个文件。
- 一次只打一条补丁，打完立刻验证，再做下一条。不要一口气全改完。

【第 2 步：要打哪几条】
按这个优先级来，没必要的不要打：
A.（可选，最安全）@deepseek-ai/dsh-llm —— 让 llm/stream 拿到可写请求。
   注意：如果你装了 dsh-context-reclaim 这个插件，它已经自己接管了，这条**不用打**，
   除非你在插件里把 DSH_RECLAIM_WRITABLE_REQUEST 设成了 0。
B.（可选）@deepseek-ai/dsh-client-ui-sidebar —— 侧栏页脚槽位加 flex-wrap，纯样式。
C.（可选）@deepseek-ai/dsh-session-format-v1-to-v2 与 @deepseek-ai/dsh-session-persistence-jsonl
   —— 只有在我遇到「会话整体打不开、报 turn/start N does not open expected turn N-1」时才打。
D.（可选）@earendil-works/pi-ai 的 dist/api/simple-options.js —— 把 max_tokens 的下界从 1 改成 1024，
   并读取环境变量 DSH_PI_AI_MAX_TOKENS_FLOOR（设 0 表示恢复上游）。
E.（谨慎）@deepseek-ai/dsh-agent-loop 与 @deepseek-ai/dsh-llm-pi-ai —— 运行时快照回收 + 系统提示收敛。
   这两条改动较大、依赖私有实现，**只在我明确说「我遇到了上下文/系统提示重复的问题」时才做**，
   而且必须先给我看你要改什么、为什么，等我确认。

【第 3 步：如果本机有专项补丁库】
读 manifest.json，里面每条都有 targetRoot / rel / sha256 / bytes。
用库里的 restore.ps1（或按同样方式手工复制 blob）把文件落到位：
- 只在「版本匹配」时才复制（版本不符要停下来告诉我，不要强打）；
- 每个文件复制完跑 `node --check`；
- 落盘后重新算一遍 sha256，跟 manifest 里记的比对，一致才算成功；
- 打完给我一张表：哪个包、哪个文件、改了没、sha256 对不对。

【第 4 步：如果本机没有补丁库】
那就按第 2 步的说明**自己实现**，并且每一条都要：
1. 先告诉我：你要改哪个文件、改成什么样（贴出 diff 级别的说明）、为什么；
2. 我同意后再动手；
3. 改完 `node --check`；
4. 告诉我怎么回滚（原文件就是同目录的 .orig）。

【第 5 步：最后给我一份报告】
用表格列出：补丁名 / 目标文件绝对路径 / 是否已打 / 备份文件路径 / 语法检查结果 / 备注。
最后一句必须明确说清：有没有哪条没打成功、为什么。
```

### 📋 Ready-to-paste prompt (English)

```
Please apply the official DSH 1.5 file patches on this machine. Rules, strictly:

[Step 0 — recon first, do not touch anything yet]
Locate the DSH installation root (contains node_modules\@deepseek-ai\dsh\lib\bin.js) and
the active DSH_HOME (default %APPDATA%\dsh-desktop\harness). Ask me instead of guessing.
Ask whether I have a local patch library (a directory with manifest.json + restore.ps1).

[Step 1 — red lines]
- Before editing any file, back it up next to itself as <name>.orig (then .orig-2, never overwrite).
- Only edit .js/.cjs files under <DSH install root>\node_modules\. Never touch DSH_HOME.
- Never delete files. Never edit package.json versions.
- Run `node --check <file>` after every file; roll that one file back if it fails.
- One patch at a time, verify, then continue.

[Step 2 — what to patch, in priority order]
A. (optional) @deepseek-ai/dsh-llm — make llm/stream receive a windowable request.
   Skip it entirely if the dsh-context-reclaim plugin is installed (it already takes over),
   unless DSH_RECLAIM_WRITABLE_REQUEST=0 there.
B. (optional) @deepseek-ai/dsh-client-ui-sidebar — flex-wrap on the footer slot (pure CSS).
C. (optional) @deepseek-ai/dsh-session-format-v1-to-v2 + @deepseek-ai/dsh-session-persistence-jsonl —
   only if sessions fail to open with "turn/start N does not open expected turn N-1".
D. (optional) @earendil-works/pi-ai dist/api/simple-options.js — raise the max_tokens floor from 1
   to 1024, honouring DSH_PI_AI_MAX_TOKENS_FLOOR (0 = upstream).
E. (careful) @deepseek-ai/dsh-agent-loop + @deepseek-ai/dsh-llm-pi-ai — runtime snapshot reclaim and
   system-prompt convergence. Only if I explicitly report duplicated context/system prompts, and show
   me the exact change and get my approval first.

[Step 3 — if a patch library exists]
Use manifest.json (targetRoot / rel / sha256 / bytes) and restore.ps1. Only copy when the version
matches; stop and tell me otherwise. `node --check` every file, recompute sha256, compare, and report
a table: package / file / applied / sha256 match.

[Step 4 — if it does not exist]
Implement each patch yourself, but for every one: (1) tell me the target file and a diff-level
description plus the reason, (2) wait for my approval, (3) `node --check`, (4) tell me the rollback
(the sibling .orig).

[Step 5 — final report]
A table: patch / absolute target path / applied / backup path / syntax check / notes, and a closing
sentence stating clearly which patches did NOT succeed and why.
```

---

## 四、验收

打完补丁后，重启 DSH，看启动日志：

| 现象 | 含义 |
|---|---|
| `[reclaim/patch-check] …都已检测到补丁痕迹` | 体检认为补丁在位（启发式） |
| `[reclaim/wire] … options 冻结=false` | 可写请求成立——**打没打 `dsh-llm` 补丁都是这个结果**，因为插件自己也会接管 |
| 启动报 `Failed to load plugins` | 某个文件被改坏了，用同目录 `.orig` 回滚，或跑补丁库的 `revert.ps1` / `restore.ps1` |

**回滚**：每个被改的文件旁边都有 `*.orig`，把它复制回原名即可。补丁库另有 `revert.ps1`。

---

## 五、常见问题

**Q：不打补丁，四个插件真的都能用？**
能。唯一的硬依赖（可写请求）已经内置。剩下 8 条与四个插件无关。

**Q：打了补丁会不会跟插件冲突？**
不会。请求到插件时**已经不冻结**的话，插件原样透传，零行为变化。两边都做同一件事，结果一致。

**Q：DSH 升级了怎么办？**
升级会覆盖 `node_modules`，补丁全部失效（`*.orig` 可能还在，属于残留，不影响运行）。
重新装插件即可——插件是从 profile 加载的，升级不影响；补丁按上面的提示词再让 agent 打一遍。

**Q：体检说「未检测到」是不是坏了？**
不是。它是启发式：只认「文件旁边有 `.orig` 备份」。手工删过备份、或补丁本来就不是用这种脚本打的，都会显示未检测到。

---

## 六、四个插件之间的联动（强制说明）

- **`dsh-context-reclaim` ↔ `dsh-aux-degrade`（上下文治理两件套）**：两者共用
  「这次调用是主线还是辅助」的判据（`tools.length > 0 ? 'main' : 'aux'`），但**只部分重合**：
  被 aux-degrade 降级的调用，是「被判定为 aux」的调用的**子集**（显式 `tools: []` 会走 aux 但不会被降级；
  aux-degrade 还额外要求 `purpose === undefined`）。两者**互不 import、互不探测**，
  只装一个完全可用，唯一差别是 `[reclaim/usage]` 里 `purpose=` 字段的可观测性。
  **建议一起安装**，否则 `purpose` 归因会缺一块信息。
- **`dsh-composer-launcher` → `dsh-capability-composer`**：启动器负责浏览器扩展桥、插件条目映射与语言跟随；
  组合器负责真正的裁剪与状态。**组合器没装时点击「设置组合」会明确提示缺少哪个插件**，不会静默失败。
- **`dsh-composer-launcher` → `dsh-mcp-manager-ui`（第三方）**：启动器的 MCP 入口会调用它的服务；
  没装时提示「MCP 管理服务未连接」。**启动器刻意不把 `remote.mcpManager` 写进硬依赖**——
  写进去会让没装那个第三方插件的机器整个插件不激活（这是 1.0.0 修掉的一个真 bug）。

---

## 七、一句话总结

> 装插件 → 重启 → 看日志里那行 `[reclaim/patch-check]`。
> 它说「未检测到」就让它说，**四个插件照常工作**；
> 真想打补丁，把上面的提示词交给你的 agent，让它先看清你的机器再动手。
