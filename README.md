<div align="center">

# dsh-context-reclaim

**Reclaim the context before tool results ever reach the model.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-1.5-8a2be2.svg)](#compatibility)
[![Platform](https://img.shields.io/badge/platform-desktop%20%7C%20web-lightgrey.svg)](#compatibility)

**English** · [简体中文](README.zh-CN.md)

</div>

---

## What this is

A DSH session's context is not blown up by the conversation; it is blown up by **tool results**: a single `read` of several hundred lines, a single `pwsh` dumping a wall of logs, a system prompt repeated verbatim every turn. Once this content has entered the history, the only thing left is for the compactor to operate on it after the fact — and compaction has to rewrite already-committed history, which knocks out the whole server-side prefix cache and makes every compaction more expensive than the last.

`dsh-context-reclaim` moves to a different position: it handles them **before the tool result is appended to history**, and it never rewrites content that has already been committed. So the prefix cache is never invalidated because of this plugin.

It hooks into 5 seams:

| Seam | What it does | Default |
|---|---|---|
| `tools/post-execute` | Purify a tool result the moment it is produced + bound it by content type, inserting a retrieval pointer at the truncation point | on |
| `system-prompt/assemble` | Fold the tool definition surface, stabilize the order of prefix sections, truncate over-long description lines | on |
| `tools/pre-execute` | Duplicate-edit interception (a second identical edit to the same content of the same file is rejected outright) | on |
| `session/event` | Compaction-summary integrity audit (warns when a compaction summary is missing sections) | on |
| `llm/stream` | One cost-attribution line per request, printing route / prompt / cache hit / output | on |

---

## 1. Tool-result purification and bounding

This is the core. Every time a tool call returns, the plugin first performs **lossless purification**, then **bounding**.

### Lossless purification

Collapses ANSI escape sequences, strips trailing whitespace, normalizes CR. This step is pure purification and loses no information.

It only acts when the content meets **both** thresholds: length ≥ 32 characters, and a reduction ratio after purification ≥ 0.2%. Small results are not touched at all.

Turn it off: `config.noise = false`, or the environment variable `DSH_RECLAIM_NOISE=0`.

### Bounding by content type

Different types of tool results have completely different tolerances. The plugin sorts tools into three classes:

| Class | Tools covered | Head / tail kept | Per-line cap | Total character cap |
|---|---|---|---|---|
| **Read-only** | `read` `grep` `glob` `codegraph_*` `lsp_*` | 80 lines / 12 lines | 512 | 160 |
| **Side-effecting** | `pwsh` `bash` `docker_*` `job_output` | 40 lines / 40 lines | 1024 | 256 |
| **Faithful** | `web_fetch` `web_search` `knowledge_*` `read_image` `pilot_snapshot` | left exactly as-is | — | — |

Tools it does not recognize are treated as **faithful** — better to save nothing than to cause unintended damage.

Wherever content was truncated, a retrieval pointer is inserted telling you how much of the original is left and how it can be retrieved, rather than dropping it silently.

The trigger threshold for bounding is "saves more than 5%"; if it does not save much, nothing is touched.

Turn it off: `config.bounded = false`, or the environment variable `DSH_RECLAIM_BOUNDED=0`.

> **About oversized results**: content above `config.maxInlineBytes` (default 50000) is handed to the spill mechanism to be written to disk. This requires the spill plugin to be installed in your profile — without it, this threshold has no effect and over-limit content passes through unchanged.

### The faithful allowlist

The lists for all three tool classes can be replaced wholesale in the configuration:

```yaml
- id: reclaim
  config:
    readOnlyTools: ['read', 'grep', 'glob']      # a full-table replacement, not an append
    sideEffectTools: ['pwsh', 'bash']
    faithfulTools: ['web_fetch', 'web_search']
```

Note that this is a **full-table replacement**, not a per-field merge — writing only `headLines` will lose the character caps. Either write the whole table or write none of it.

---

## 2. Tool definition surface folding

At the start of every session, DSH stuffs the complete definitions (name, description, parameter schema) of every available tool into the system prompt. With dozens of plugins installed, this block can account for a large proportion of it, while most of those tools will not be used at all in the current turn.

By default the plugin **folds** this part: it keeps the full definitions of the most frequently used tools and compresses the rest into a one-line list. They can still be retrieved on demand via `search_tools` / `load_tools`.

Turn it off: `config.foldTools = false`, or the environment variable `DSH_RECLAIM_TOOL_FOLD=0`.

---

## 3. Prefix stabilization

A server-side prefix cache only hits when the **prefix is byte-for-byte unchanged**. Yet the system prompt inherently carries a pile of things that change every turn: token counts, timestamps, session sequence numbers.

By default the plugin flattens these volatile numbers and reorders the sections so that stable sections come first and volatile ones last. Each reorder prints one `[reclaim/section-order]` line in the log, telling you which sections were moved.

---

## 4. Truncating over-long description lines

The system prompt occasionally contains a single exceptionally long description line (long comments written by some plugins). Lines above the threshold (not exposed in `config`; the environment variable `DSH_RECLAIM_PROMPT_LINE_MAX`, default 120 characters) are truncated, and the line numbers that were truncated are printed to the log.

---

## 5. Duplicate-edit interception

If the model issues exactly the same modification to the same content of the same file twice in a row, the second one is intercepted and an explanation is returned — such a call is almost certainly a meaningless duplicate that burns a whole round trip for nothing.

Log line: `[reclaim/dedup-deny]`.

Turn it off: the environment variable `DSH_RECLAIM_DEDUP_DENY=0`.

---

## 6. Compaction-summary integrity audit

If the summary produced by the compactor is truncated by the output budget, it **silently** becomes shorter — you receive no notice at all, the next turn simply starts with a piece of the context missing.

After every compaction the plugin audits whether the summary contains the structural sections it should have, and warns when any are missing:

```
[reclaim/summary-audit] ⚠️ 摘要缺 3/8 段
```

It **only warns, it does not modify the summary**. What actually prevents summaries from being truncated is [`dsh-aux-degrade`](#-with-dsh-aux-degrade-the-context-governance-pair--install-both-together); see the interaction section below.

---

## 7. Cost attribution

One line is printed at the end of every request:

```
[reclaim/usage] route=aux prompt=12043 hit=11890 miss=153 out=204 purpose=compaction
```

`hit` / `miss` are the prefix-cache hit and miss character counts, and `purpose` is the purpose of this call (if it has one). When the cache is broken, an extra `[reclaim/cache-break]` line is printed.

This log is the fastest entry point for diagnosing "why is my cache hit rate not high?".

---

## Configuration

The configuration file is the profile's `cordis.patch.yml`:

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

| Key | Type | Default | Effect |
|---|---|---|---|
| `enabled` | boolean | `true` | Master switch (`!== false` counts as on) |
| `noise` | boolean | `true` | Lossless purification (ANSI / trailing whitespace / CR) |
| `bounded` | boolean | `true` | Bounding by content type + retrieval pointer |
| `stripLines` | boolean | `false` | Strip line-number prefixes |
| `noOpGuardRatio` | number | `0.05` | The "only act if it saves enough" threshold for bounding, 5% |
| `maxInlineBytes` | number | `50000` | Above this byte count, content goes to spill (spill plugin required) |
| `readOnlyTools` | string[] | see the table above | Read-only tool list, **a full-table replacement** |
| `sideEffectTools` | string[] | see the table above | Side-effecting tool list, **a full-table replacement** |
| `faithfulTools` | string[] | see the table above | Faithful tool list, **a full-table replacement** |
| `attribution` | boolean | `true` | Print the `[reclaim/usage]` attribution line |
| `trimSections` | boolean | `false` | Section trimming (note: the real gate is the environment variable `DSH_RECLAIM_SECTION_TRIM`, see below) |
| `foldTools` | boolean | `true` | Fold the tool definition surface |
| `activePlugins` | string[] | `[]` | Plugin list participating in section-ownership computation |

> ⚠️ The value of the `trimSections` option does not actually open the gate — the gate in the code only honours the environment variable `DSH_RECLAIM_SECTION_TRIM`, and it additionally requires `activePlugins` to be non-empty. The old documentation got this one wrong; it is stated accurately here.

### Common environment variables

There are more than 40 environment variables in total, covering every internal threshold. Grouped by function, the most commonly used ones are:

| Variable | Default | Effect |
|---|---|---|
| `DSH_RECLAIM_NOISE` | `1` | Set to `0` to turn off lossless purification |
| `DSH_RECLAIM_BOUNDED` | `1` | Set to `0` to turn off bounding |
| `DSH_RECLAIM_STRIP_LINES` | `0` | Set to `1` to strip line numbers |
| `DSH_RECLAIM_TOOL_FOLD` | `1` | Set to `0` to turn off tool definition surface folding |
| `DSH_RECLAIM_PROMPT_LINE_MAX` | `120` | Truncation threshold for a single system-prompt line |
| `DSH_RECLAIM_DEDUP_DENY` | `1` | Set to `0` to turn off duplicate-edit interception |
| `DSH_RECLAIM_SECTION_TRIM` | `0` | Set to `1` to turn on section trimming (works together with `activePlugins`) |
| `DSH_RECLAIM_STABILIZE` | `1` | Set to `0` to turn off prefix stabilization |
| `DSH_RECLAIM_LOG` | `1` | Set to `0` to turn off this plugin's log output |
| `DSH_RECLAIM_DUMP_SYSTEM` | `0` | Set to `1` to dump the assembled system prompt to a temporary directory, for diagnosis |

The remaining threshold variables (sampling line counts, budget observation, pollution-detection window, archive limits, reasoning stripping, etc.) each have a per-item comment at the top of the source.

---

## Installation

### From the DSH plugin marketplace

Search for `dsh-context-reclaim` in the DSH plugin marketplace and click install.

### From GitHub

```bash
dsh plugin --profile web add github:xiamubumu/dsh-context-reclaim
```

### From npm

```bash
dsh plugin --profile web add dsh-context-reclaim
```

After installing you **need to restart DSH** — host-side plugins are only loaded when DSH starts.

This plugin has **no runtime dependencies at all**; `peerDependencies` only declares the official `@deepseek-ai/dsh-tools`. Installation will not stuff any third-party package into your profile.

---

## Compatibility

| | |
|---|---|
| **DSH kernel** | **1.5 series** (`0.1.5-rc.2` ≤ version < `0.2.0`) — this is exactly the range written in `package.json`'s `engines.dsh`. Later DSH versions will be followed up |
| **Form factor** | **Desktop ✅ · Web ✅** — more precisely, **anything running DSH is supported**; this plugin does not depend on any desktop-only capability |
| **Operating system** | Windows · macOS · Linux |
| **Node syntax** | 20 and above (this is the syntax floor the source uses; **you do not need to install Node yourself**, DSH ships its own runtime) |

This plugin has a hard, ranged requirement on the DSH kernel version: `engines.dsh` is declared as `>=0.1.5-rc.2 <0.2.0`, and the plugin marketplace judges compatibility accordingly. Once DSH upgrades to `0.2.0` this plugin will be ruled incompatible, and a new version will be published at that point.

---

## 🔗 Interaction with other plugins

### 🔗 With `dsh-aux-degrade` (the context governance pair) — install both together

`dsh-context-reclaim` and [`dsh-aux-degrade`](https://github.com/xiamubumu/dsh-aux-degrade) are the two halves of the same "context governance" scheme. **Installing both together is strongly recommended; this is the most important interaction this plugin has.**

**① They share the same routing criterion.** Both plugins use the same test to tell a "main-conversation call" from an "auxiliary call":

```
tools.length > 0 ? 'main' : 'aux'
```

reclaim uses it to tag cost attribution with `route=`, and aux-degrade uses it to decide whether to lower the reasoning effort of this call. **The criterion must be identical**, otherwise the two plugins will disagree about "which call counts as an auxiliary call", one saving while the other leaks.

**② How they divide the work.** reclaim handles **content** (purification and bounding of tool results before they enter history, tool definition surface folding, prefix stabilization); aux-degrade handles **calls** (lowering the reasoning effort of auxiliary calls such as compaction summaries / session titles to `off`, and appending two faithful-preservation requirements to the compaction instruction).

**③ What happens without the other.**

| Installed alone | Result |
|---|---|
| Only reclaim | Everything works as usual. But auxiliary calls still burn the full reasoning budget, and compaction summaries can still be truncated by the output cap — reclaim will only print `[reclaim/summary-audit] ⚠️ 摘要缺 N/8 段` in the log to remind you, **it will not modify the summary itself** (this is deliberate: reclaim does not touch committed content) |
| Only aux-degrade | Everything works as usual. But tool results are not purified or bounded, and long results enter history unchanged |

**④ They do not depend on each other.** reclaim's source contains **no `import` / `require` at all**, and aux-degrade only imports the official `@deepseek-ai/schemastery`. They do not probe each other and do not reference each other — **either one can be installed alone and work normally**, just with different coverage. This is also why they are two repositories rather than one.

**⑤ One practical detail.** If you turn on reclaim's `[reclaim/usage]` attribution log, you will see a `purpose=` field in it. That field exists to diagnose "**which class of auxiliary call is not being lowered to off by aux-degrade**" — it is a read-only diagnostic that changes no behaviour. When you see `purpose=unknown` or a purpose you have never seen before, that usually means some auxiliary call path bypasses the degrade criterion.

**⑥ In one sentence.** With reclaim installed and aux-degrade missing, you will see the problem but cannot fix it; with aux-degrade installed and reclaim missing, your auxiliary calls are saved but your tool results are not. Install both, and context governance is complete.

### 🔗 With `dsh-capability-composer`

reclaim internally maintains an ownership table of "which section of the system prompt belongs to whom" (`SECTION_OWNER`), in which the "available plugins" section belongs to [`dsh-capability-composer`](https://github.com/xiamubumu/dsh-capability-composer).

In other words: **the plugin list should not be trimmed by reclaim** — that is the capability composer's job. When both are installed, narrowing of the section is carried out by the composer, and reclaim only keeps the default behaviour when the composer is absent.

### 🔗 With `dsh-composer-launcher`

No direct coupling. The two can be installed in any combination.

---

## FAQ

<details>
<summary><b>Will it break my prefix cache?</b></summary>

No. This is the most important design constraint of the plugin: **it only acts before content enters history, and never rewrites content that has already been committed**. The committed part stays byte-for-byte identical, so the prefix cache will never be invalidated because of reclaim.
</details>

<details>
<summary><b>Will it alter my tool output?</b></summary>

It only truncates when the threshold is exceeded, and it always leaves a retrieval pointer at the truncation point. The purification layer is lossless (ANSI escapes, trailing whitespace — things that carry no information in the first place). In addition, three classes of tools are listed as "faithful": **they pass through unchanged, not a single character is touched**.
</details>

<details>
<summary><b>Do I need to restart after installing?</b></summary>

Yes. Host-side plugins are loaded when DSH starts. After one restart it stays in effect.
</details>

<details>
<summary><b>Will it install anything else into my profile?</b></summary>

No. The plugin has zero runtime dependencies, `peerDependencies` declares only official packages, and the installation process introduces no third-party code.
</details>

<details>
<summary><b>How do I know how much it actually saved?</b></summary>

Look at the `hit` / `miss` fields of the `[reclaim/usage]` log line — those are the real per-request prefix-cache character counts. A truncated result carries its own note at the truncation point (how much was saved, how to retrieve it).
</details>

<details>
<summary><b>Does it support web DSH?</b></summary>

Yes. This plugin is a host-side plugin and only depends on Cordis's generic seams (`tools/post-execute`, `system-prompt/assemble`, `session/event`, `llm/stream`), with no dependency on Electron or any desktop-only capability. **As long as it is DSH, both desktop and web work.**
</details>

<details>
<summary><b>Why are there two plugins both called "context governance"?</b></summary>

Because they handle two different layers of the same thing: one handles **content** (how results are processed before entering history), the other handles **calls** (how much reasoning budget an auxiliary call spends). See the [interaction section](#-with-dsh-aux-degrade-the-context-governance-pair--install-both-together) above.
</details>

---

## Repository layout

```
dsh-context-reclaim/
├── index.js            # the entire implementation (single file, no external dependencies)
├── cordis.patch.yml    # DSH plugin manifest patch
├── package.json
├── verify.mjs          # offline self-check: node verify.mjs
├── README.md           # English
└── README.zh-CN.md     # Simplified Chinese
```

## Self-check

```bash
node verify.mjs
```

Runs offline and writes nothing to disk. It checks the manifest fields, the syntax, whether any private key or backup file slipped in, and whether any hard-coded machine path exists in the runtime code.

## License

[MIT](LICENSE) © 2026 夏目 ([xiamubumu](https://github.com/xiamubumu))
