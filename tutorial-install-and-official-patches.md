# Tutorial: installing the four plugins, and whether the "official patches" still need to be applied
*This is the English translation of `教程-安装与官方补丁.md`; if the two ever disagree, the Chinese original is authoritative.*

Applicable versions: **DSH 1.5 series** (`0.1.5-rc.2` ≤ version < `0.2.0`). Works on both the desktop and web builds — **if it's DSH, it's supported**.

---

## 1. Install the plugins first (three steps, no file edits)

The four plugins are **independent** repositories. You can install just one, or all four.

### Option A: install from GitHub (recommended; measured on a fresh `DSH_HOME`)

The four plugins are **independent** repositories. You can install just one, or all four:

```bash
dsh plugin --profile web add github:xiamubumu/dsh-context-reclaim
dsh plugin --profile web add github:xiamubumu/dsh-aux-degrade
dsh plugin --profile web add github:xiamubumu/dsh-capability-composer
dsh plugin --profile web add github:xiamubumu/dsh-composer-launcher
```

| Plugin | What it does | Suggestion |
|---|---|---|
| `dsh-context-reclaim` | Context reclaim: purifying and bounding tool results, folding the tool surface, prefix stability, cache-hit attribution | **Strongly recommended** |
| `dsh-aux-degrade` | Auxiliary-model downgrade: strips tools from compression calls, backstops maxTokens, preserves load-bearing content | Use as a pair with reclaim |
| `dsh-capability-composer` | Capability composer: trims skills/plugins/tools per scenario, loads them on demand | Optional |
| `dsh-composer-launcher` | Composer launcher: browser-extension bridge, plugin entry mapping, language following | Optional (its only dependency is itself) |

The `github:` shorthand needs `git` on the machine (pnpm uses it to resolve the repository's HEAD commit).

### Option B: air-gapped machines / no git — install from a downloaded tarball

Download one tarball per plugin from its Releases page, then install by path:

```bash
dsh plugin --profile web add /path/to/dsh-context-reclaim-1.1.0.tgz
dsh plugin --profile web add /path/to/dsh-aux-degrade-1.1.0.tgz
dsh plugin --profile web add /path/to/dsh-capability-composer-1.1.0.tgz
dsh plugin --profile web add /path/to/dsh-composer-launcher-1.1.0.tgz
```

The delivery package already contains all four tarballs under `npm-tarballs\`.

### Option C: from the DSH plugin marketplace / npm (not yet possible)

The marketplace submission (an `awesome-dsh-plugin` PR) has not been filed and nothing is published on npm yet ⇒ **neither route works today**.
Once listed/published, searching the plugin name in DSH's marketplace and clicking install is all there is to it.

> ⚠️ **Known issue: do not feed the release asset's tarball URL to `dsh plugin add`.**
> `dsh plugin --profile web add https://github.com/.../releases/download/v1.1.0/....tgz` fails on the pnpm DSH bundles (10.34.5) with
> `ERR_PNPM_MISSING_TARBALL_INTEGRITY` ([pnpm#14351](https://github.com/pnpm/pnpm/issues/14351), fixed upstream only in pnpm ≥ 12.5.1).
> Installing a second plugin that way **always** fails — use Option A or B.

Once they're installed, **restart DSH**. DSH's bundle mechanism registers them into the profile's `dsh.profile.bundles` automatically, so **you don't need to edit `cordis.patch.yml` by hand**, and you don't need to fill in any paths — none of the four plugins hardcodes an install path.

### After installing, confirm these 5 things

1. `[reclaim/writable]` and `[reclaim/patch-check]` appear in the startup log ⇒ context-reclaim is loaded; **send one message** and `[reclaim/wire]` / `[reclaim/usage]` show up too (those two print per request).
2. `[reclaim/patch-check]` appears in the startup log ⇒ the patch health check is working (covered in the next section).
3. Lines beginning with `[composer]` appear in the startup log and there is no `Failed to load plugins` ⇒ capability-composer is working.
4. A composer entry shows up in the sidebar; click it and you can see plugin entries.
5. Browser extension: **not required**; if you want it there are two routes (next subsection).

### The browser extension: does it install itself?

**What can be automatic already is; the part that cannot be is stated plainly.**

Chromium will not let anything silently sideload an extension into the browser you use every day. That is a browser security rule, not an unfinished feature. So:

| Route | How | Manual steps |
|---|---|---|
| **A. Zero manual** | In the composer's Tabs row press **Launch debug browser** (*用带扩展的浏览器打开*). The plugin spawns a separate Chromium process, attaches the staged extension with `--load-extension`, **then verifies over the debugging port that it really mounted**; if the old profile refuses those switches it automatically retries on a clean one. | **none** |
| **B. Into your everyday browser** | In the Tabs row press **[Open the extensions page]** + **[Copy the extension path]**, then in the extensions page turn on "Developer mode" → "Load unpacked" → paste the path. Or from a terminal: `pwsh -ExecutionPolicy Bypass -File .\install-extension.ps1` (it lists the browsers found on this machine and opens the right extensions page; `-Browser edge` skips the question). | one time, ~20 seconds |
| **C. Fleet deployment** | Chromium enterprise policy `ExtensionSettings` / `ExtensionInstallForcelist` + a self-hosted signed CRX + an HTTPS update manifest. | needs administrator rights; **not shipped here** |

Worth knowing:

- **A is verified, not promised.** Chromium reports no error when `--load-extension` is ignored, so every launch the plugin asks the debugging port for its raw target list and confirms that what appeared is **this extension's own** `background.js`. If both attempts fail it returns `extensionLoaded: false` honestly and the Tabs row falls back to reading tabs over the debugging port — it never pretends to have succeeded.
- **B's path is staged by the plugin itself** at `%APPDATA%\dsh-desktop\harness\extensions\dsh-tab-bridge` (platform-specific locations on macOS and Linux), so it **exists as soon as the plugin is installed** — you never have to go looking for it.
- The extension only fills the **Tabs** row with your real browser's open pages; **without it every other feature still works**.
- Details and screenshots: the "The browser extension" chapter of the launcher repository's README.

---

## 2. The official patches: the answer today

### In one sentence

> **None of the four plugins needs any official patch.**
> The only patch that used to be mandatory (the `@deepseek-ai/dsh-llm` writable request) has been
> handled by `dsh-context-reclaim` **at the plugin layer** since 1.0.0.
> The remaining 8 patches change DSH's own machine behavior, so **no plugin can replace them**;
> they are **optional enhancements**: applying them makes things smoother, skipping them doesn't
> affect the four plugins.

### Why that patch used to be mandatory

The host **deep-freezes** the main-line conversation request before handing it to `@deepseek-ai/dsh-llm`, whose entry point is:

```js
streamWithRegistration(options, prepared) {
  return this.ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(options, prepared))
}
```

The waterfall's `next` **ignores its arguments**, and the adapter reads that frozen outer `options`. So a plugin can read the request but not change it.
The whole official patch is just those six lines turned into "shallow-copy it into a writable object, then enter the waterfall".
**That logic now lives in `dsh-context-reclaim`**: installing the plugin takes effect, with no file touched.

Measured on a real 1.5 runtime with **zero patches**, using real requests:

```
# default (the plugin takes over)
[reclaim/wire] 入口探测：messages=5 条 · options 冻结=false · messages 冻结=false · route=…
# take-over disabled (DSH_RECLAIM_WRITABLE_REQUEST=0)
[reclaim/wire] 入口探测：messages=5 条 · options 冻结=true  · messages 冻结=true  · route=…
```

### The patch library: these 10 official patches are published separately now (five ways to apply them)

You do **not** have to hand-edit any of the patches in the table above. They ship as a standalone
repository — the patches themselves, an adaptive applier, a revert tool and a prompt for your agent:

**https://github.com/xiamubumu/dsh-patch-library**

```bash
git clone https://github.com/xiamubumu/dsh-patch-library
cd dsh-patch-library
node apply.mjs --check          # read-only: what state is this machine in
node apply.mjs --apply --all    # apply everything that lines up
node apply.mjs --revert --all   # revert in one command
```

Pick any of the five ways:

| Way | How | Who it is for |
|---|---|---|
| **A script** | `node apply.mjs --apply --all`; narrow it with `--only mcp-client,compaction-pruner` | most people — backups, syntax checks, rollback included |
| **B `git apply`** | `cd <pkg dir> && git apply -p1 --check <library>/patches/<id>/change.diff` | you want to read every byte first |
| **C your own agent** | paste the library's `PROMPT.md` into your assistant | you want it done and reported as a table |
| **D regenerate for your build** | `node tools/make-patch.mjs --file … --orig …` | `--check` reports `variant` (same version, different build) |
| **E revert** | `node apply.mjs --revert --all`, or copy the `.orig` back | any time |

The applier **finds your installation by itself** (no hard-coded paths) and guarantees: it only writes
files inside the resolved install root; a `.orig` backup is written once and never overwritten; every
write is followed by `node --check` and rolls back on a syntax error; a hunk that does not match
**exactly once** near its recorded position is reported as a conflict instead of guessed; it never
touches `$DSH_HOME`. The repository contains zero hard-coded paths and zero personal information —
`node verify.mjs` checks that on every CI run, 60 assertions, all passing.

> **If you use `dsh-context-reclaim`**: patch #1 `dsh-llm-writable-request` is **not needed** — the
> writable-request capability is already taken over by this plugin. The library detects that case and
> prints `not needed: the dsh-context-reclaim plugin already handles this`.

### All 10 official patches (the honest table)

| # | Patch | File changed | What it does | Can a plugin replace it? | Apply it? |
|---|---|---|---|---|---|
| 1 | `@deepseek-ai/dsh-llm` | `lib/index.js` | Lets `llm/stream` receive a **writable** request | ✅ **Yes, already built in** | **Not needed** |
| 2 | `@deepseek-ai/dsh-client-ui-sidebar` | `lib/lib-client.js` | Adds `flex-wrap` to the sidebar footer slot (pure styling) | ✅ Yes (a client plugin can inject CSS) | Optional |
| 3 | `@deepseek-ai/dsh-agent-loop` | `lib/index.js` | Reclaims the runtime snapshot every turn + converges the system prompt to a single entry | ❌ No (requires changing private projection classes and the commit point) | Apply once sessions get slow |
| 4 | `@deepseek-ai/dsh-llm-pi-ai` | `lib/index.js` | `splitSystemPrompt` collects every leading system prompt | ❌ No, and **pointless without 3** | Apply together with 3 |
| 5 | `@deepseek-ai/dsh-compaction-tool-result-pruner` | `lib/index.js` | Compression-time result pruning + load-bearing token guard | ❌ No (the host `new`s that class directly; there is no registration seam) | Apply if you want cheaper compaction |
| 6 | `@deepseek-ai/dsh-client-ui-renderer` | `lib/client.js` | `conversation.chat.turnTail` chain election (delivery-row ordering) | ❌ No (requires editing the official client bundle) | Apply only when several plugins need turnTail at once |
| 7 | `@deepseek-ai/dsh-session-format-v1-to-v2` | `lib/index.js` | Fixes `turn/start N does not open expected turn N-1` | ❌ No (it runs inside the session-restore path) | **Apply if you ever hit a session that won't open** |
| 8 | `@deepseek-ai/dsh-session-persistence-jsonl` | `lib/worker.cjs` | Same as above, persistence side (worker thread) | ❌ No | Apply together with 7 |
| 9 | `@deepseek-ai/dsh-mcp-client` | `lib/index.js` | MCP tools sync **incrementally** + reconnect cap 10 → 100000: exhausting the cap used to unregister every tool of that server and stop reconnecting, so one flaky MCP server rewrote the whole tools section and broke the cache prefix | ❌ No (it edits that package's own reconnect and registration flow) | Apply when you run MCP servers that flap |
| 10 | `@earendil-works/pi-ai` | `dist/api/simple-options.js` | `max_tokens` gets clamped to 1 ⇒ introduces `FLOOR=1024` | ❌ No (third-party dist; the ESM namespace is read-only) | Apply if you see "the output is only a word or two" |

> On #9: it reads the `DSH_PI_AI_MAX_TOKENS_FLOOR` environment variable; set it to `0` to restore upstream behavior.


### The detection system (the dialog and the startup check share it)

Three levels, ordered by reliability:

| Level | Signal | Verdict |
|---|---|---|
| 1 | file sha256 **equals** `patched.sha256` in the library `manifest.json` | **applied** (exact) |
| 2 | file sha256 **equals** `pristine.sha256` | **not applied** (exact) |
| 3 | neither matches, but the patch `marker` string is present | **applied** (fallback for upstream version drift) |
| — | none of the above | **cannot tell** (it guesses neither way) |

The startup check additionally uses the presence of a `*.orig` backup as a **corroborating** signal — it is weaker than the three levels above (a hand-deleted backup reports "not applied"), so it only ever produces one log line; it never decides anything.

The dialog labels its evidence ("applied · confirmed by content hash" / "applied · confirmed by marker") and keeps **"not applied" and "cannot tell" separate**. If any single patch is not firmly "applied", the dialog appears and the copy-paste prompt definitely includes it. That is what "apply whatever is missing" means here: nothing is ever silently skipped.

**Calibration**: these verdicts were compared item by item against the patch library own `node apply.mjs --check --json`, on both a fully patched desktop install and a zero-patch npm install. They agreed everywhere (including one item both sides call "cannot be located exactly" — neither guesses).

### The "patch health check" at startup

On every load, `dsh-context-reclaim` logs **exactly one line**:

```
[reclaim/patch-check] 官方补丁体检（只读，本插件不会自动改官方文件）：7 个目标里未检测到 7 条 —— …
```

It is **read-only and never acts on its own**. Changing files inside your DSH installation is your decision; it should not be a side effect of "I installed a plugin".
Its criterion is heuristic (it looks for the `*.orig` backups the patch scripts leave next to the files), which is why it says "not detected" rather than "not applied"; when it can't infer the install layout, it says nothing at all. Turn it off with `DSH_RECLAIM_PATCH_CHECK=0`.

**Don't panic when you see that line**: not one of the things it lists affects how the four plugins work.

---

## 3. Want the patches applied? Let your agent do it (recommended)

Don't have a plugin edit official files on your behalf, and don't copy a script with hardcoded paths.
**Copy the whole block below into your agent** (DSH / Claude Code / Codex all work). It will look at your machine first, then act.

> Note: if this machine already has a dedicated patch library (a directory containing `manifest.json` and `restore.ps1`), give the agent its path as well — it will prefer that route (copying ready-made patches is the least work and the least error-prone).

> **Easier option**: just paste the library's ready-made prompt
> → <https://github.com/xiamubumu/dsh-patch-library/blob/main/PROMPT.md>
> That version makes the agent run `--check` first, apply only the patches reported as `exact`, come
> back and ask you about anything reported as `variant`, and finish with a table of
> "state before / action taken / where the backup is / syntax check / restart needed".
> The prompt below is the same thing **inlined** — for when the machine cannot clone the library
> right now and you want one single pasted block.

### 📋 Ready-to-paste prompt

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
A. (optional) @deepseek-ai/dsh-llm — make llm/stream receive a writable request.
   Skip it entirely if the dsh-context-reclaim plugin is installed (it already takes over),
   unless DSH_RECLAIM_WRITABLE_REQUEST=0 there.
B. (optional) @deepseek-ai/dsh-client-ui-sidebar — flex-wrap on the footer slot (pure CSS).
C. (optional) @deepseek-ai/dsh-session-format-v1-to-v2 + @deepseek-ai/dsh-session-persistence-jsonl —
   only if sessions fail to open with "turn/start N does not open expected turn N-1".
D. (optional) @earendil-works/pi-ai dist/api/simple-options.js — raise the max_tokens floor from 1
   to 1024, honoring DSH_PI_AI_MAX_TOKENS_FLOOR (0 = upstream).
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

> A Chinese version of this same prompt ships with the source document, in `教程-安装与官方补丁.md`. The steps and the red lines are identical; use whichever language you prefer.

---

## 4. Acceptance

After applying the patches, restart DSH and read the startup log:

| What you see | What it means |
|---|---|
| `[reclaim/patch-check] …都已检测到补丁痕迹` | The health check believes the patches are in place (heuristic) |
| `[reclaim/wire] … options 冻结=false` | The writable request holds — **this is the result whether or not you applied the `dsh-llm` patch**, because the plugin takes over on its own |
| Startup reports `Failed to load plugins` | A file got broken; roll it back from the sibling `.orig`, or run the patch library's `revert.ps1` / `restore.ps1` |

**Rolling back**: every edited file has a `*.orig` next to it — copy it back over the original name. The patch library also ships a `revert.ps1`.

---

## 5. FAQ

**Q: With no patches applied, do all four plugins really work?**
Yes. The one hard dependency (a writable request) is built in. The other 8 have nothing to do with the four plugins.

**Q: Will the patches conflict with the plugins?**
No. If the request is **already unfrozen** by the time it reaches the plugin, the plugin passes it straight through — zero behavior change. Both sides do the same thing, and the result is the same.

**Q: What happens when DSH is upgraded?**
An upgrade overwrites `node_modules`, so every patch is gone (the `*.orig` files may still be there; that's leftovers and doesn't affect anything).
Just reinstall the plugins — they load from the profile, so an upgrade doesn't affect them. For the patches, hand the prompt above to your agent again.

**Q: The health check says "not detected" — is something broken?**
No. It's heuristic: it only recognizes a `.orig` backup sitting next to the file. If you deleted the backups by hand, or the patches were never applied with that kind of script, it will show "not detected".

---

## 6. How the four plugins interact (mandatory note)

- **`dsh-context-reclaim` ↔ `dsh-aux-degrade` (the two-part context-governance set)**: they share the
  "is this call main-line or auxiliary" criterion (`tools.length > 0 ? 'main' : 'aux'`), but they **only partly overlap**:
  a call downgraded by aux-degrade is a **subset** of the calls judged auxiliary (explicit `tools: []` takes the aux route
  but is not downgraded; aux-degrade additionally requires `purpose === undefined`). The two **never import each other and never
  probe each other**, and installing just one is fully usable — the only difference is how much the `purpose=` field in
  `[reclaim/usage]` can tell you. **We recommend installing both**, otherwise `purpose` attribution is missing a piece.
- **`dsh-composer-launcher` → `dsh-capability-composer`**: the launcher owns the browser-extension bridge, plugin entry mapping and language following;
  the composer owns the actual trimming and state. **When the composer isn't installed, clicking the 「设置组合」 ("Configure composition") entry says exactly which plugin is missing** — it does not fail silently.
- **`dsh-composer-launcher` → `dsh-mcp-manager-ui` (third-party)**: the launcher's MCP entry calls that plugin's service;
  when it isn't installed you get 「MCP 管理服务未连接」 ("MCP management service not connected"). **The launcher deliberately keeps `remote.mcpManager` out of its hard dependencies** —
  listing it there would deactivate the entire plugin on machines without that third-party plugin (a real bug fixed in 1.0.0).

---

## 7. One-line summary

> Install the plugins → restart → look at that `[reclaim/patch-check]` line in the log.
> If it says "not detected", let it say that — **the four plugins work either way**;
> if you really do want the patches, hand the prompt above to your agent and let it read your machine before it touches anything.
