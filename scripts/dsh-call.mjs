#!/usr/bin/env node
/**
 * One-shot call through the official DeepSeek Harness (`dsh`) and the
 * `dsh-our-free-model` plugin.
 *
 * This module deliberately owns no wire protocol. It prepares the plugin's
 * settings, points the headless profile at the `our-free-model` provider, runs
 * `dsh --profile headless`, and projects the JSON event stream into the result
 * shape used by `emit-result.mjs`.
 *
 * @module scripts/dsh-call.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const PROVIDER = 'our-free-model'
export const FREE_COMBO = 'combo:gha'
export const LANE_MODELS = {
  kilo: 'kilo-auto/free',
  opencode: 'deepseek-v4.1-flash-free',
}
/** The combo tries the no-Bun lane first, then the OpenCode free models. */
export const COMBO_MODELS = [
  LANE_MODELS.kilo,
  LANE_MODELS.opencode,
  'glm-5.3-flash-free',
]

export const DEFAULT_MAX_INPUT_CHARS = 60_000
export const DEFAULT_MAX_OUTPUT_TOKENS = 1200
export const DEFAULT_TIMEOUT_MS = 180_000

export class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UsageError'
    this.code = 'USAGE_ERROR'
  }
}

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*(['"])[^'"]{12,}\1/gi,
]

/** Strip common credential spellings before the prompt leaves the runner. */
export function redactText(value) {
  let text = String(value ?? '')
  let count = 0
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    text = text.replace(pattern, () => {
      count += 1
      return '[REDACTED]'
    })
  }
  return { text, count }
}

/** Hard cap the prompt so a giant diff cannot overflow the model context. */
export function capText(value, maxChars) {
  const text = String(value ?? '')
  if (text.length <= maxChars) return { text, truncated: false, omitted: 0 }
  const omitted = text.length - maxChars
  return {
    text: `${text.slice(0, maxChars)}\n\n[truncated ${omitted} characters]`,
    truncated: true,
    omitted,
  }
}

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === null || value === '') return fallback
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) throw new UsageError(`${name} must be a positive integer`)
  return Math.trunc(number)
}

/**
 * Map the action's lane vocabulary onto a provider selection. `auto` uses the
 * combo the plugin resolves at turn time, so failover stays upstream's job.
 */
export function selectionFor(lane, model) {
  if (lane !== 'auto' && lane !== 'kilo' && lane !== 'opencode') {
    throw new UsageError('lane must be auto, kilo, or opencode')
  }
  const explicit = typeof model === 'string' ? model.trim() : ''
  if (explicit !== '') return { lane, model: explicit, source: 'explicit' }
  if (lane === 'auto') return { lane, model: FREE_COMBO, source: 'combo' }
  return { lane, model: LANE_MODELS[lane], source: 'default' }
}

/**
 * Merge the fields this caller owns into the plugin's settings document. The
 * plugin's JsonStore already merges missing top-level keys with its defaults,
 * so preserving unrelated keys is enough.
 */
export function mergeSettings(existing, maxOutputTokens) {
  const next = existing !== null && typeof existing === 'object' && !Array.isArray(existing)
    ? { ...existing }
    : {}
  next.defaultMaxTokens = maxOutputTokens
  const combos = Array.isArray(next.combos) ? [...next.combos] : []
  const entry = {
    id: FREE_COMBO,
    name: 'GitHub Actions',
    models: [...COMBO_MODELS],
    strategy: 'fallback',
    stickyLimit: 1,
    enabled: true,
  }
  const index = combos.findIndex(combo => combo !== null && typeof combo === 'object' && combo.id === FREE_COMBO)
  if (index === -1) combos.unshift(entry)
  else combos[index] = { ...combos[index], ...entry }
  next.combos = combos
  return next
}

/** The patch overlay that selects the provider route and model. */
export function modelPatch(selection) {
  return [
    '- id: agent-default-model',
    '  config:',
    `    provider: ${JSON.stringify(PROVIDER)}`,
    `    model: ${JSON.stringify(selection.model)}`,
    '',
  ].join('\n')
}

/**
 * Parse `dsh --json` output. The terminal `final` event carries the lossless
 * answer; the last status event that has `usage` carries the token counts.
 */
export function parseEvents(text) {
  const events = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line.trim() === '') continue
    try {
      const parsed = JSON.parse(line)
      if (parsed !== null && typeof parsed === 'object') events.push(parsed)
    } catch {
      // A truncated final line is possible after a timeout; earlier events
      // still describe the run.
    }
  }
  const final = [...events].reverse().find(event => event.type === 'final') ?? null
  const usageEvent = [...events].reverse().find(event => event.type === 'status' && event.usage)
  const textEvent = [...events].reverse().find(event => event.type === 'text' && typeof event.text === 'string')
  return {
    events,
    final,
    usage: usageEvent?.usage ?? null,
    sessionId: final?.sessionId ?? events.find(event => event.type === 'session')?.sessionId ?? null,
    text: typeof final?.text === 'string' ? final.text : (textEvent?.text ?? ''),
  }
}

function readTextFile(file, name) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (error) {
    throw new UsageError(`cannot read ${name} ${file}: ${error?.message ?? error}`)
  }
}

function readJsonFile(file) {
  if (!fs.existsSync(file)) return {}
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    // Keep the damaged document for inspection; the plugin already backs up
    // corrupt settings on its own next load.
    const backup = `${file}.corrupt-${Date.now()}`
    try { fs.copyFileSync(file, backup) } catch { /* best effort */ }
    return {}
  }
}

function writeFileAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, content, { mode: 0o600 })
  fs.renameSync(temporary, file)
}

/** Resolve the DSH home the same way the plugin does. */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv.trim())
  return path.join(os.homedir(), '.dsh')
}

function run(command, args, { input, timeoutMs }) {
  return new Promise(resolve => {
    const started = Date.now()
    // A Windows npm shim is a .cmd file, which needs the shell. CI runs Linux;
    // this only affects local CLI use.
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let killTimer

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000)
      killTimer.unref?.()
    }, timeoutMs)
    timer.unref?.()

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      resolve({ code: null, signal: null, stdout, stderr, timedOut, error, elapsedMs: Date.now() - started })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      resolve({ code, signal, stdout, stderr, timedOut, error: null, elapsedMs: Date.now() - started })
    })
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

function errorMessage(stderr, final) {
  const fromFinal = final?.reason?.error?.message
  if (typeof fromFinal === 'string' && fromFinal.trim() !== '') return fromFinal.trim().slice(0, 500)
  const line = String(stderr ?? '').split(/\r?\n/).reverse().find(value => value.trim() !== '')
  return (line ?? 'dsh did not produce a final event').trim().slice(0, 500)
}

/** Turn one finished dsh process into the result document consumed downstream. */
export function resultFromRun({ selection, parsed, process: proc, startedAt }) {
  const final = parsed.final
  const reason = final?.reason ?? null
  const kind = typeof reason?.kind === 'string' ? reason.kind : null
  const text = String(parsed.text ?? '').trim()
  const exitZero = proc.code === 0 && proc.error === null
  let code = null
  let message = null

  if (proc.timedOut) {
    code = 'TIMEOUT'
    message = `dsh did not finish within the timeout`
  } else if (proc.error !== null && proc.error !== undefined) {
    code = 'TRANSPORT'
    message = String(proc.error.message ?? proc.error).slice(0, 500)
  } else if (!exitZero) {
    code = reason?.error?.code ?? `DSH_EXIT_${proc.code ?? proc.signal ?? 'UNKNOWN'}`
    message = errorMessage(proc.stderr, final)
  } else if (kind !== 'completed') {
    code = reason?.error?.code ?? 'DSH_ERROR'
    message = errorMessage(proc.stderr, final)
  } else if (text === '') {
    code = 'EMPTY_RESPONSE'
    message = 'dsh completed without answer text'
  }

  const ok = code === null
  const usage = parsed.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  return {
    ok,
    lane: selection.lane,
    model: selection.model,
    modelSource: selection.source,
    text,
    finish: kind ?? (proc.timedOut ? 'timeout' : null),
    truncated: false,
    usage,
    elapsedMs: Date.now() - startedAt,
    attempts: [
      {
        lane: selection.lane,
        model: selection.model,
        ok,
        code: code ?? undefined,
        status: null,
        elapsedMs: proc.elapsedMs,
      },
    ],
    redactions: 0,
    inputTruncated: false,
    inputOmittedChars: 0,
    ...(code === null ? {} : { code, message }),
    sessionId: parsed.sessionId,
    at: new Date().toISOString(),
  }
}

function parseArgs(argv) {
  const args = {
    lane: 'auto',
    model: null,
    prompt: null,
    promptFile: null,
    system: null,
    systemFile: null,
    out: 'result.json',
    events: null,
    maxInputChars: String(DEFAULT_MAX_INPUT_CHARS),
    maxOutputTokens: String(DEFAULT_MAX_OUTPUT_TOKENS),
    timeoutMs: String(DEFAULT_TIMEOUT_MS),
    permissionMode: 'read-only',
    dsh: process.env.DSH_BIN ?? 'dsh',
    softFail: false,
    verbose: false,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--help' || flag === '-h') { args.help = true; continue }
    if (flag === '--soft-fail') { args.softFail = true; continue }
    if (flag === '--verbose') { args.verbose = true; continue }
    const value = argv[++index]
    if (value === undefined) throw new UsageError(`${flag} requires a value`)
    const key = {
      '--lane': 'lane', '--model': 'model', '--prompt': 'prompt', '--prompt-file': 'promptFile',
      '--system': 'system', '--system-file': 'systemFile', '--out': 'out', '--events': 'events',
      '--max-input-chars': 'maxInputChars', '--max-output-tokens': 'maxOutputTokens',
      '--timeout-ms': 'timeoutMs', '--permission-mode': 'permissionMode', '--dsh': 'dsh',
    }[flag]
    if (key === undefined) throw new UsageError(`unknown flag ${flag}`)
    args[key] = value
  }
  return args
}

const HELP = `Usage: node scripts/dsh-call.mjs --prompt-file <path> [options]

Calls the free model lanes through the official dsh headless profile. The dsh
CLI and the dsh-our-free-model plugin must already be installed.

  --lane auto|kilo|opencode  Lane selection (default auto)
  --model <id>               Explicit model id or combo id
  --prompt <text>            Inline prompt
  --prompt-file <path>       Prompt file; wins over --prompt
  --system <text>            Instruction prepended to the task
  --system-file <path>       Instruction file; wins over --system
  --out <path>               Result JSON path (default result.json)
  --events <path>            Also write the raw ndjson event stream
  --max-input-chars <n>      Prompt cap after redaction (default 60000)
  --max-output-tokens <n>    Plugin defaultMaxTokens (default 1200)
  --timeout-ms <n>           Whole-run timeout (default 180000)
  --permission-mode <name>   read-only | workspace-write | danger-full-access
  --dsh <path>               dsh executable (default dsh or DSH_BIN)
  --soft-fail                Exit 0 when the run fails
  --verbose                  Print progress to stderr
`

export async function main(argv = process.argv.slice(2)) {
  let args
  try {
    args = parseArgs(argv)
    if (args.help) {
      process.stdout.write(HELP)
      return 0
    }
    const prompt = args.promptFile !== null ? readTextFile(args.promptFile, 'prompt file') : args.prompt
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      throw new UsageError('prompt is required (use --prompt or --prompt-file)')
    }
    const system = args.systemFile !== null
      ? readTextFile(args.systemFile, 'system file')
      : (typeof args.system === 'string' ? args.system : '')
    const selection = selectionFor(args.lane, args.model)
    const maxInputChars = positiveInteger(args.maxInputChars, DEFAULT_MAX_INPUT_CHARS, 'maxInputChars')
    const maxOutputTokens = positiveInteger(args.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 'maxOutputTokens')
    const timeoutMs = positiveInteger(args.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs')
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(args.permissionMode)) {
      throw new UsageError('permission mode must be read-only, workspace-write, or danger-full-access')
    }

    const redactedPrompt = redactText(prompt)
    const redactedSystem = redactText(system)
    const capped = capText(redactedPrompt.text, maxInputChars)
    const task = redactedSystem.text.trim() === ''
      ? capped.text
      : `${redactedSystem.text.trim()}\n\n${capped.text}`

    const home = dshHome()
    const dataDir = path.join(home, 'our-free-model')
    const settingsFile = path.join(dataDir, 'settings.json')
    const settings = mergeSettings(readJsonFile(settingsFile), maxOutputTokens)
    writeFileAtomic(settingsFile, `${JSON.stringify(settings, null, 2)}\n`)

    const patchDir = process.env.RUNNER_TEMP || os.tmpdir()
    const patchFile = path.join(patchDir, 'free-model-action-model.yml')
    writeFileAtomic(patchFile, modelPatch(selection))

    const startedAt = Date.now()
    if (args.verbose) process.stderr.write(`dsh-call: ${selection.lane} -> ${selection.model}\n`)
    const proc = await run(args.dsh, [
      '--patch', patchFile,
      '--profile', 'headless',
      '--permission-mode', args.permissionMode,
      '--approval-policy', 'never',
      '--json', '-',
    ], { input: task, timeoutMs })

    const parsed = parseEvents(proc.stdout)
    if (args.events !== null) writeFileAtomic(args.events, proc.stdout)
    const result = resultFromRun({ selection, parsed, process: proc, startedAt })
    result.redactions = redactedPrompt.count + redactedSystem.count
    result.inputTruncated = capped.truncated
    result.inputOmittedChars = capped.omitted
    writeFileAtomic(args.out, `${JSON.stringify(result, null, 2)}\n`)
    if (args.verbose) {
      process.stderr.write(`dsh-call: ok=${result.ok} finish=${result.finish} elapsed=${result.elapsedMs}ms\n`)
      if (!result.ok) process.stderr.write(`dsh-call: ${result.code}: ${result.message}\n`)
    }
    return result.ok || args.softFail ? 0 : 1
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`dsh-call: ${error.message}\n`)
      return 2
    }
    process.stderr.write(`dsh-call: ${error?.stack ?? error}\n`)
    return 2
  }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().then(code => { process.exitCode = code })
}
