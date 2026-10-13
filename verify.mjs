#!/usr/bin/env node
/*
 * Self-check for this plugin repository.
 *
 * Runs fully offline and writes nothing. Safe to run anywhere:
 *   node verify.mjs
 *   node verify.mjs --quiet
 *
 * Exit code 0 when there is no FAIL, 1 otherwise. Warnings never fail the run.
 *
 * Checks, in order:
 *   1. layout      — the files a DSH profile needs are present
 *   2. manifest    — package.json declares what the plugin marketplace reads
 *   3. syntax      — every .js/.mjs/.cjs parses (node --check)
 *   4. secrets     — no private keys and no editor/build leftovers
 *   5. hard coding — absolute machine paths in runtime code (warning only)
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const QUIET = process.argv.includes('--quiet')

const SKIP_DIRS = new Set(['node_modules', '.git', '.pnpm', 'dist', 'screenshots', 'coverage'])
const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs'])
const REQUIRED_MANIFEST_FIELDS = ['name', 'version', 'license', 'description', 'repository', 'engines']
const SECRET_PATTERNS = [
  [/\.pem$/i, 'private key'],
  [/\.key$/i, 'private key'],
  [/\.p12$/i, 'key store'],
  [/\.bak-/i, 'editor backup'],
  [/\.orig$/i, 'merge/backup leftover'],
  [/\.log$/i, 'log file'],
  [/(^|[\\/])\.env(\.|$)/i, 'environment file']
]
const HARDCODE_PATTERNS = [
  [/\b[A-Za-z]:[\\/](?!\/)/, 'Windows absolute path'],
  [/(^|[^A-Za-z0-9_])[\\/](?:Users|home)[\\/][A-Za-z0-9._-]+/, 'absolute home path']
]
// A literal preceded by one of these is an explicit fallback, not a hard-coded machine.
const ENV_FALLBACK = /process\.env(?:\.[A-Za-z0-9_]+|\[['"][^'"]+['"]\])\s*(?:\?\?|\|\|)/

/*
 * 翻译词条是**给用户看的字**，不是代码依赖的路径：
 * 「请填绝对路径（例如 D:\work\项目）」不该被当成硬编码机器路径。
 */
const I18N_ENTRY = /^\s{6}'[A-Za-z0-9_.]+':\s*['"]/

let passed = 0
let warned = 0
let failed = 0
const warnings = []
const failures = []

function ok(msg) {
  passed++
  if (!QUIET) console.log(`  ok    ${msg}`)
}
function warn(msg, detail) {
  warned++
  warnings.push(msg)
  console.log(`  warn  ${msg}${detail ? ` — ${detail}` : ''}`)
}
function fail(msg, detail) {
  failed++
  failures.push(msg)
  console.log(`  FAIL  ${msg}${detail ? ` — ${detail}` : ''}`)
}

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      walk(join(dir, e.name), out)
    } else if (e.isFile()) {
      out.push(join(dir, e.name))
    }
  }
  return out
}

const rel = (p) => relative(ROOT, p).split(sep).join('/')

console.log(`verifying ${ROOT}\n`)

// ---------------------------------------------------------------- 1. layout
console.log('layout')
const manifestPath = join(ROOT, 'package.json')
if (!existsSync(manifestPath)) {
  fail('package.json is missing')
}
let manifest = null
if (existsSync(manifestPath)) {
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    ok('package.json parses')
  } catch (err) {
    fail('package.json is not valid JSON', err.message)
  }
}

let patchRel = null
if (manifest) {
  patchRel = manifest.dsh?.bundle?.patch
  if (typeof patchRel !== 'string' || patchRel.length === 0) {
    fail('package.json does not declare dsh.bundle.patch — DSH will not load this plugin')
  } else if (!existsSync(join(ROOT, patchRel))) {
    fail(`dsh.bundle.patch points at a file that does not exist`, patchRel)
  } else {
    ok(`cordis patch present (${patchRel})`)
  }
}

if (existsSync(join(ROOT, 'LICENSE'))) ok('LICENSE present')
else warn('LICENSE is missing')

if (existsSync(join(ROOT, 'README.md'))) ok('README.md present')
else fail('README.md is missing')

// -------------------------------------------------------------- 2. manifest
console.log('\nmanifest')
if (manifest) {
  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (manifest[field] === undefined || manifest[field] === null || manifest[field] === '') {
      fail(`package.json is missing "${field}"`)
    }
  }
  if (manifest.private === true) {
    fail('package.json has "private": true — npm would refuse to publish it')
  } else {
    ok('publishable (no "private": true)')
  }
  const range = manifest.engines?.dsh
  if (typeof range !== 'string' || range.length === 0) {
    fail('package.json does not declare engines.dsh — the marketplace cannot judge compatibility')
  } else if (range.length > 256) {
    fail(`engines.dsh is ${range.length} characters; the marketplace caps it at 256`)
  } else {
    ok(`engines.dsh = ${range}`)
  }
  if (manifest.repository && typeof manifest.repository === 'object' && !manifest.repository.url) {
    fail('repository is an object without a "url"')
  }
  if (manifest.dsh?.client && !manifest.dsh?.bundle?.patch) {
    fail('declares only dsh.client — that alone is not installable as a bundle')
  }
}

// ---------------------------------------------------------------- 3. syntax
console.log('\nsyntax')
const allFiles = walk(ROOT)
const sources = allFiles.filter((f) => SOURCE_EXT.has(f.slice(f.lastIndexOf('.'))))
let parsed = 0
for (const f of sources) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' })
    parsed++
  } catch (err) {
    const msg = (err.stderr?.toString() ?? err.message).split('\n').slice(0, 3).join(' ').trim()
    fail(`syntax error in ${rel(f)}`, msg)
  }
}
if (parsed === sources.length && sources.length > 0) ok(`parsed ${parsed} JavaScript file(s)`)

// --------------------------------------------------------------- 4. secrets
console.log('\nsecrets and leftovers')
let flaggedFiles = 0
for (const f of allFiles) {
  for (const [re, label] of SECRET_PATTERNS) {
    if (re.test(f)) {
      fail(`${label} in the tree: ${rel(f)}`)
      flaggedFiles++
    }
  }
}
if (flaggedFiles === 0) ok('no private keys, backups, logs or .env files')

// ------------------------------------------------------------ 5. hard coding
console.log('\nhard-coded machine paths (warning only)')
function isCommentLine(line) {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}
let hardHits = 0
for (const f of sources) {
  let text
  try {
    text = readFileSync(f, 'utf8')
  } catch {
    continue
  }
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (isCommentLine(line)) continue
    if (ENV_FALLBACK.test(line)) continue // explicit env fallback (dot or bracket form)
    if (I18N_ENTRY.test(line)) continue // translation entry: user-facing copy, not a path we depend on
    for (const [re, label] of HARDCODE_PATTERNS) {
      if (re.test(line)) {
        hardHits++
        warn(`${label} at ${rel(f)}:${i + 1}`, line.trim().slice(0, 110))
        break
      }
    }
  }
}
if (hardHits === 0) ok('no absolute machine paths in runtime code')

// ------------------------------------------------------------------ summary
console.log(`\n${passed} passed · ${warned} warning(s) · ${failed} failed`)
if (failed > 0) {
  console.log('\nVERIFY FAILED')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('\nVERIFY PASSED')
