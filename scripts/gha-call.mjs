#!/usr/bin/env node
/**
 * One-shot caller for the two credential-free model lanes.
 *
 * The action is deliberately a thin CLI: it reuses the wire primitives vendored
 * from dsh-our-free-model and does not mount the DSH harness, the adapter, or
 * the standalone gateway. One request in, one JSON result out.
 *
 * Lane order for `--lane auto` is Kilo first and OpenCode second. Kilo needs no
 * Bun and no client fingerprint, so it is the lane most likely to survive a
 * shared GitHub-hosted runner IP. OpenCode is retained as the fallback and as
 * an explicit choice for callers who want its model roster.
 *
 * The caller retries nothing on 429/403 and falls forward at most once. A quota
 * refusal is a finding, not a transient error, and a retry only burns the next
 * window.
 *
 * @module scripts/gha-call.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { applyFingerprint, endpointFor, isCanonicalSession, sessionForConversation, wireFor } from '../vendor/ofm/upstream.js'
import { CODE, getJson, postStreamed } from '../vendor/ofm/http.js'
import { fetchKiloListing, postKiloStreamed } from '../vendor/ofm/kilo.js'
import { readStream } from '../vendor/ofm/stream.js'

export const VERSION = '0.1.0'
export const DEFAULT_KILO_MODEL = 'kilo-auto/free'
export const DEFAULT_OPENCODE_MODEL = 'deepseek-v4.1-flash-free'
export const DEFAULT_MAX_OUTPUT_TOKENS = 1200
export const DEFAULT_TIMEOUT_MS = 180_000
export const DEFAULT_MAX_INPUT_CHARS = 60_000
export const ATTRIBUTION_UA = `free-model-action/${VERSION}`

const USAGE = `free-model-action ${VERSION}

Usage:
  node scripts/gha-call.mjs --live --prompt "Reply with PONG" --lane auto --out result.json
  node scripts/gha-call.mjs --live --prompt-file prompt.txt --lane kilo
  node scripts/gha-call.mjs --live --request request.json --out result.json

Required:
  --live                    Actually send the request. Without it the CLI exits 2.
  --prompt <text>           Prompt text, or --prompt-file <path>.
  --prompt-file <path>      Read the prompt from a UTF-8 file.

Lane:
  --lane auto|kilo|opencode Default: auto (Kilo first, then OpenCode).
  --model <id>              Pin a lane model. Requires --lane kilo or --lane opencode.
  --no-listing              Skip model-roster discovery and use the built-in default.

Limits:
  --max-output-tokens <n>   Default ${DEFAULT_MAX_OUTPUT_TOKENS}.
  --timeout-ms <n>          Per-lane budget. Default ${DEFAULT_TIMEOUT_MS}.
  --max-input-chars <n>     Prompt cap after redaction. Default ${DEFAULT_MAX_INPUT_CHARS}.
  --session-seed <text>     Stable OpenCode session seed. Default derives from the run.

Output:
  --out <path>              Write the result JSON here; otherwise print it to stdout.
  --soft-fail               Exit 0 even when every lane fails.
  --strict                  Exit 1 when every lane fails (default).
  --verbose                 Print lane progress to stderr.
  --help                    Show this text.

Request JSON (--request) may contain:
  lane, model, system, prompt, maxOutputTokens, timeoutMs, maxInputChars,
  sessionSeed, listing, softFail
CLI flags override fields in the request file.

Environment:
  DSH_HOME                     Session-map location. Default: ~/.dsh.
  OUR_FREE_MODEL_BASE          OpenCode base URL override.
  OUR_FREE_MODEL_KILO_BASE     Kilo base URL override.
  OUR_FREE_MODEL_BUN           Bun executable for the OpenCode POST lane.
  OUR_FREE_MODEL_FREE_TRANSPORT=node  Legacy Node transport (not recommended).
`

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

const ALWAYS_FREE = new Set(['big-pickle', 'union-alpha', 'space-bunny-free'])

export class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UsageError'
    this.code = 'USAGE_ERROR'
  }
}

function flagKey(flag) {
  return flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
}

const VALUE_FLAGS = new Set([
  '--request', '--prompt', '--prompt-file', '--system', '--system-file',
  '--lane', '--model', '--max-output-tokens', '--timeout-ms',
  '--max-input-chars', '--session-seed', '--out',
])
const BOOL_FLAGS = new Set(['--live', '--soft-fail', '--strict', '--help', '--verbose', '--no-listing'])

/** Parse argv into the small flag vocabulary above. */
export function parseArgs(argv) {
  const args = { live: false, softFail: false, strict: false, help: false, verbose: false, listing: true }
  for (let index = 0; index < argv.length; index += 1) {
    let flag = argv[index]
    let inline
    if (flag.startsWith('--')) {
      const equals = flag.indexOf('=')
      if (equals > 0) {
        inline = flag.slice(equals + 1)
        flag = flag.slice(0, equals)
      }
    }
    if (BOOL_FLAGS.has(flag)) {
      if (inline !== undefined) throw new UsageError(`${flag} does not take a value`)
      if (flag === '--live') args.live = true
      else if (flag === '--soft-fail') args.softFail = true
      else if (flag === '--strict') args.strict = true
      else if (flag === '--help') args.help = true
      else if (flag === '--verbose') args.verbose = true
      else if (flag === '--no-listing') args.listing = false
      continue
    }
    if (!VALUE_FLAGS.has(flag)) throw new UsageError(`unknown flag ${flag}`)
    let value = inline
    if (value === undefined) {
      if (index + 1 >= argv.length) throw new UsageError(`${flag} requires a value`)
      value = argv[++index]
    }
    args[flagKey(flag)] = value
  }
  return args
}

export function checkNode(version = process.versions.node) {
  const major = Number(version.split('.')[0])
  const minor = Number(version.split('.')[1])
  if ((major === 22 && minor >= 19) || major >= 24) return
  throw new UsageError(`Node 22.19+ or 24+ is required (current ${version})`)
}

function readTextFile(file) {
  const absolute = path.resolve(file)
  try {
    return fs.readFileSync(absolute, 'utf8')
  } catch (error) {
    throw new UsageError(`cannot read ${file}: ${error?.message ?? error}`)
  }
}

function integerInRange(value, fallback, min, max, name) {
  if (value === undefined || value === null || value === '') return fallback
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new UsageError(`${name} must be an integer`)
  if (number < min || number > max) throw new UsageError(`${name} must be between ${min} and ${max}`)
  return number
}

/** Best-effort secret redaction before any byte reaches a third-party lane. */
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

/** Hard cap the prompt so a giant diff cannot overflow the lane's context. */
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

/** Normalize a request object and apply the caps/redaction that always run. */
export function normalizeRequest(input) {
  const source = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const lane = source.lane === undefined || source.lane === null || source.lane === '' ? 'auto' : String(source.lane)
  if (!['auto', 'kilo', 'opencode'].includes(lane)) {
    throw new UsageError('lane must be auto, kilo, or opencode')
  }
  const prompt = typeof source.prompt === 'string' ? source.prompt : ''
  if (prompt.trim() === '') throw new UsageError('prompt is required (use --prompt or --prompt-file)')

  const model = typeof source.model === 'string' && source.model.trim() !== '' ? source.model.trim() : null
  if (lane === 'auto' && model !== null) {
    throw new UsageError('--model requires --lane kilo or --lane opencode; auto picks one default per lane')
  }

  const system = typeof source.system === 'string' && source.system !== '' ? source.system : null
  const maxInputChars = integerInRange(source.maxInputChars, DEFAULT_MAX_INPUT_CHARS, 1, 1_000_000, 'maxInputChars')
  const maxOutputTokens = integerInRange(source.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 1, 32_000, 'maxOutputTokens')
  const timeoutMs = integerInRange(source.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 900_000, 'timeoutMs')
  const sessionSeed = typeof source.sessionSeed === 'string' && source.sessionSeed.trim() !== ''
    ? source.sessionSeed.trim()
    : null

  const redactedPrompt = redactText(prompt)
  const redactedSystem = system === null ? { text: null, count: 0 } : redactText(system)
  const capped = capText(redactedPrompt.text, maxInputChars)
  return {
    lane,
    model,
    system: redactedSystem.text,
    prompt: capped.text,
    maxInputChars,
    maxOutputTokens,
    timeoutMs,
    listing: source.listing !== false,
    softFail: source.softFail === true,
    verbose: source.verbose === true,
    sessionSeed,
    redactions: redactedPrompt.count + redactedSystem.count,
    inputTruncated: capped.truncated,
    inputOmittedChars: capped.omitted,
  }
}

function readRequestFile(file) {
  let parsed
  try {
    parsed = JSON.parse(readTextFile(file))
  } catch (error) {
    if (error instanceof UsageError) throw error
    throw new UsageError(`--request is not valid JSON: ${error?.message ?? error}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UsageError('--request must contain a JSON object')
  }
  return parsed
}

/** Merge a request file and CLI overrides into one normalized request. */
export function loadRequest(args) {
  const request = args.request === undefined ? {} : readRequestFile(args.request)
  // A file wins over an inline value, matching the action inputs: the file is
  // the path for large inputs, and passing both should not silently send the
  // small one.
  if (args.prompt !== undefined) request.prompt = args.prompt
  if (args.promptFile !== undefined) request.prompt = readTextFile(args.promptFile)
  if (args.system !== undefined) request.system = args.system
  if (args.systemFile !== undefined) request.system = readTextFile(args.systemFile)
  if (args.lane !== undefined) request.lane = args.lane
  if (args.model !== undefined) request.model = args.model
  if (args.maxOutputTokens !== undefined) request.maxOutputTokens = args.maxOutputTokens
  if (args.timeoutMs !== undefined) request.timeoutMs = args.timeoutMs
  if (args.maxInputChars !== undefined) request.maxInputChars = args.maxInputChars
  if (args.sessionSeed !== undefined) request.sessionSeed = args.sessionSeed
  if (args.softFail) request.softFail = true
  if (args.strict) request.softFail = false
  if (args.listing === false) request.listing = false
  if (args.verbose) request.verbose = true
  return normalizeRequest(request)
}

/** The lane walk. `auto` never retries a lane; it only moves to the next one. */
export function lanePlan(lane) {
  if (lane === 'kilo') return ['kilo']
  if (lane === 'opencode') return ['opencode']
  return ['kilo', 'opencode']
}

function listingRows(payload) {
  if (Array.isArray(payload?.data)) return payload.data
  if (Array.isArray(payload?.models)) return payload.models
  if (Array.isArray(payload)) return payload
  return []
}

function isFreeLaneId(modelId) {
  const base = String(modelId ?? '').replace(/\([^()]+\)\s*$/, '').trim()
  if (ALWAYS_FREE.has(base)) return true
  return /(?:^|[-_])free(?:$|[-_.])/.test(base)
}

function messagesFor(request) {
  const messages = []
  if (request.system !== null) messages.push({ role: 'system', content: request.system })
  messages.push({ role: 'user', content: request.prompt })
  return messages
}

function defaultSessionSeed() {
  const repo = process.env.GITHUB_REPOSITORY ?? 'local'
  const run = process.env.GITHUB_RUN_ID ?? process.env.GITHUB_RUN_ATTEMPT ?? String(process.pid)
  return `gha:${repo}:${run}`
}

function sessionSeed(request, lane, model) {
  // A caller-supplied canonical session is kept verbatim; upstream validates
  // it with the same predicate, so do not re-implement half of it here.
  if (request.sessionSeed !== null && isCanonicalSession(request.sessionSeed)) return request.sessionSeed
  return `${request.sessionSeed ?? defaultSessionSeed()}:${lane}:${model}`
}

/** The roster GET uses its own session, never the turn's canonical id. */
function catalogSeed(request) {
  return `${request.sessionSeed ?? defaultSessionSeed()}:catalog`
}

async function resolveKiloModel(request) {
  if (request.model !== null) return { model: request.model, source: 'explicit' }
  if (!request.listing) return { model: DEFAULT_KILO_MODEL, source: 'default' }
  try {
    const payload = await fetchKiloListing({ timeoutMs: Math.min(15_000, request.timeoutMs) })
    const free = listingRows(payload)
      .filter(row => row?.isFree === true && typeof row?.id === 'string' && row.id.trim() !== '')
    const preferred = free.find(row => row.id.trim() === DEFAULT_KILO_MODEL)
    const chosen = preferred ?? free[0]
    return chosen === undefined
      ? { model: DEFAULT_KILO_MODEL, source: 'default' }
      : { model: chosen.id.trim(), source: 'listing' }
  } catch {
    return { model: DEFAULT_KILO_MODEL, source: 'default' }
  }
}

async function resolveOpenCodeModel(request) {
  if (request.model !== null) {
    const wire = wireFor(request.model)
    if (wire !== 'chat') {
      throw new UsageError(`model ${request.model} uses the ${wire} wire; this caller supports chat-wire models only`)
    }
    return { model: request.model, source: 'explicit' }
  }
  if (!request.listing) return { model: DEFAULT_OPENCODE_MODEL, source: 'default' }
  try {
    const session = sessionForConversation(catalogSeed(request))
    const payload = await getJson('/inference/v1/models', {
      session,
      attributionUserAgent: ATTRIBUTION_UA,
      timeoutMs: Math.min(15_000, request.timeoutMs),
    })
    const ids = listingRows(payload)
      .map(row => (typeof row === 'string' ? row : row?.id))
      .filter(id => typeof id === 'string' && id.trim() !== '')
      .map(id => id.trim())
      // The caller builds a Chat body for every OpenCode model. Keep the
      // roster walk on that wire rather than sending a Chat body to a
      // Responses/Messages endpoint.
      .filter(id => isFreeLaneId(id) && wireFor(id) === 'chat')
    const preferred = ids.find(id => id === DEFAULT_OPENCODE_MODEL)
    const chosen = preferred ?? ids[0]
    return chosen === undefined
      ? { model: DEFAULT_OPENCODE_MODEL, source: 'default' }
      : { model: chosen, source: 'listing' }
  } catch {
    return { model: DEFAULT_OPENCODE_MODEL, source: 'default' }
  }
}

/**
 * Project the lane's SSE payloads into the harness stream shape and return the
 * assembled answer. `readStream` already handles all three wires, usage
 * spelling, finish tokens, tool-block state, and the DSML scrubber.
 */
export async function collectStream(raw, wire, renameMap = new Map()) {
  const reader = readStream(raw, wire, renameMap, () => Date.now())
  let chunks = 0
  let sawToolCall = false
  while (true) {
    const step = await reader.next()
    if (step.done) {
      const snapshot = step.value ?? {}
      return {
        text: String(snapshot.answerText ?? '').trim(),
        reasoningChars: String(snapshot.reasoningText ?? '').length,
        usage: snapshot.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        finish: snapshot.finish ?? null,
        sawToolCall: sawToolCall || snapshot.sawToolCall === true,
        sawFinish: snapshot.sawFinish === true,
        chunks,
      }
    }
    chunks += 1
    const chunk = step.value
    if (chunk?.type === 'tool-call-delta' || chunk?.block?.type === 'tool-call') sawToolCall = true
  }
}

async function callKilo(request, model, signal) {
  const body = {
    model,
    messages: messagesFor(request),
    stream: true,
    max_tokens: request.maxOutputTokens,
  }
  const raw = []
  const response = await postKiloStreamed({
    body,
    signal,
    timeoutMs: request.timeoutMs,
    onData: data => raw.push(data),
  })
  const collected = await collectStream(raw, 'chat', new Map())
  return { ...collected, status: response.status }
}

async function callOpenCode(request, model, signal) {
  const body = {
    model,
    messages: messagesFor(request),
    stream: true,
    max_tokens: request.maxOutputTokens,
  }
  const renameMap = applyFingerprint(body, false)
  const raw = []
  const response = await postStreamed({
    path: endpointFor(model),
    body,
    session: sessionForConversation(sessionSeed(request, 'opencode', model)),
    attributionUserAgent: ATTRIBUTION_UA,
    signal,
    timeoutMs: request.timeoutMs,
    onData: data => raw.push(data),
  })
  const collected = await collectStream(raw, wireFor(model), renameMap)
  return { ...collected, status: response.status }
}

async function runLane(lane, request, model) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, request.timeoutMs)
  timer.unref?.()
  const started = Date.now()
  try {
    const output = lane === 'kilo'
      ? await callKilo(request, model, controller.signal)
      : await callOpenCode(request, model, controller.signal)
    return { output, elapsedMs: Date.now() - started }
  } catch (error) {
    if (timedOut) {
      throw Object.assign(new Error(`lane timed out after ${request.timeoutMs}ms`), {
        code: CODE.timeout,
        status: error?.status,
        providerRetryAfterMs: error?.providerRetryAfterMs,
        cause: error,
      })
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function positiveInteger(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : undefined
}

function attemptFromError(lane, model, modelSource, error, elapsedMs) {
  return {
    lane,
    model,
    modelSource,
    ok: false,
    code: typeof error?.code === 'string' ? error.code : 'UNKNOWN',
    status: Number.isInteger(error?.status) ? error.status : undefined,
    message: String(error?.message ?? error).slice(0, 500),
    retryAfterMs: positiveInteger(error?.providerRetryAfterMs ?? error?.retryAfterMs),
    elapsedMs,
  }
}

/** Execute the request through the lane plan. */
export async function execute(request) {
  const attempts = []
  const started = Date.now()
  const plan = lanePlan(request.lane)

  for (const lane of plan) {
    let resolved
    try {
      resolved = lane === 'kilo' ? await resolveKiloModel(request) : await resolveOpenCodeModel(request)
    } catch (error) {
      if (error instanceof UsageError) throw error
      resolved = {
        model: lane === 'kilo' ? DEFAULT_KILO_MODEL : DEFAULT_OPENCODE_MODEL,
        source: 'default',
      }
    }
    const laneStarted = Date.now()
    if (request.verbose) {
      process.stderr.write(`free-model-action: trying ${lane} (${resolved.model}, ${resolved.source})\n`)
    }
    try {
      const { output, elapsedMs } = await runLane(lane, request, resolved.model)
      const attempt = {
        lane,
        model: resolved.model,
        modelSource: resolved.source,
        ok: true,
        status: output.status,
        elapsedMs,
        finish: output.finish,
        usage: output.usage,
        reasoningChars: output.reasoningChars,
      }
      if (output.text === '') {
        const message = output.sawToolCall
          ? 'the model returned only a tool call and no text; add "do not use tools" to the prompt'
          : output.reasoningChars > 0
            ? `the model returned reasoning but no answer text (${output.reasoningChars} reasoning chars)`
            : 'the model returned an empty answer'
        if (request.verbose) process.stderr.write(`free-model-action: ${lane} returned no text; falling forward\n`)
        attempts.push({ ...attempt, ok: false, code: CODE.empty, message })
        continue
      }
      if (request.verbose) {
        process.stderr.write(`free-model-action: ${lane} answered in ${elapsedMs}ms (${output.chunks} chunks, finish ${output.finish ?? 'unknown'})\n`)
      }
      attempts.push(attempt)
      return {
        ok: true,
        lane,
        model: resolved.model,
        modelSource: resolved.source,
        text: output.text,
        finish: output.finish,
        truncated: output.finish === 'length',
        reasoningChars: output.reasoningChars,
        usage: output.usage,
        chunks: output.chunks,
        status: output.status,
        elapsedMs: Date.now() - started,
        attempts,
        redactions: request.redactions,
        inputTruncated: request.inputTruncated,
        inputOmittedChars: request.inputOmittedChars,
        at: new Date().toISOString(),
      }
    } catch (error) {
      if (error instanceof UsageError) throw error
      if (request.verbose) {
        process.stderr.write(`free-model-action: ${lane} failed with ${error?.code ?? 'UNKNOWN'}: ${String(error?.message ?? error).slice(0, 300)}\n`)
      }
      attempts.push(attemptFromError(lane, resolved.model, resolved.source, error, Date.now() - laneStarted))
    }
  }

  const last = attempts[attempts.length - 1]
  return {
    ok: false,
    lane: null,
    model: null,
    code: last?.code ?? 'UNKNOWN',
    status: last?.status,
    message: attempts.length === 0
      ? 'all lanes failed'
      : attempts.map(attempt => `${attempt.lane}: ${attempt.code}${attempt.message ? ` (${attempt.message})` : ''}`).join(' | '),
    retryAfterMs: last?.retryAfterMs,
    elapsedMs: Date.now() - started,
    attempts,
    redactions: request.redactions,
    inputTruncated: request.inputTruncated,
    inputOmittedChars: request.inputOmittedChars,
    at: new Date().toISOString(),
  }
}

/** Write the result JSON to a file or stdout; a file also gets a stderr line. */
export function writeResult(file, result) {
  const text = `${JSON.stringify(result, null, 2)}\n`
  if (file === undefined || file === null || file === '') {
    process.stdout.write(text)
    return
  }
  const absolute = path.resolve(file)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, text)
  const summary = result.ok
    ? `free-model-action: ok lane=${result.lane} model=${result.model} ${result.elapsedMs}ms`
    : `free-model-action: failed code=${result.code}${result.message ? `: ${result.message}` : ''}`
  process.stderr.write(`${summary}\n`)
}

function errorResult(error) {
  return {
    ok: false,
    code: error?.code ?? 'UNKNOWN',
    message: String(error?.message ?? error).slice(0, 1000),
    attempts: [],
    at: new Date().toISOString(),
  }
}

/** CLI entry point. Returns the process exit code. */
export async function main(argv = process.argv.slice(2)) {
  let args
  try {
    args = parseArgs(argv)
    if (args.help) {
      process.stdout.write(USAGE)
      return 0
    }
    checkNode()
    if (!args.live) {
      writeResult(args.out, {
        ok: false,
        code: 'LIVE_REQUIRED',
        message: 'pass --live to send an actual request',
        attempts: [],
        at: new Date().toISOString(),
      })
      return 2
    }
    const request = loadRequest(args)
    const result = await execute(request)
    writeResult(args.out, result)
    if (result.ok) return 0
    return request.softFail ? 0 : 1
  } catch (error) {
    writeResult(args?.out, errorResult(error))
    if (!(error instanceof UsageError)) {
      process.stderr.write(`${error?.stack ?? error}\n`)
    }
    return 2
  }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().then(code => {
    process.exitCode = code
  }).catch(error => {
    process.stderr.write(`free-model-action: ${error?.stack ?? error}\n`)
    process.exitCode = 2
  })
}
