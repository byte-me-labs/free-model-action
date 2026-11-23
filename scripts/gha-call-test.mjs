/**
 * Offline suites for the free-model caller. No network, no lane quota.
 *
 *     node scripts/gha-call-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  UsageError,
  capText,
  checkNode,
  collectStream,
  lanePlan,
  loadRequest,
  normalizeRequest,
  parseArgs,
  redactText,
  writeResult,
} from './gha-call.mjs'
import {
  MAX_COMMENT_CHARS,
  fenceFor,
  formatComment,
  formatSummary,
  sanitizeComment,
} from './emit-result.mjs'

let passed = 0
const failures = []

async function test(name, body) {
  try {
    await body()
    passed += 1
    console.log(`ok - ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`not ok - ${name}`)
    console.error(error?.stack ?? error)
  }
}

const sse = value => JSON.stringify(value)

await test('parseArgs reads the common flags', () => {
  const args = parseArgs([
    '--live', '--lane', 'kilo', '--prompt', 'PONG',
    '--max-output-tokens', '64', '--out', 'result.json', '--soft-fail',
  ])
  assert.equal(args.live, true)
  assert.equal(args.lane, 'kilo')
  assert.equal(args.prompt, 'PONG')
  assert.equal(args.maxOutputTokens, '64')
  assert.equal(args.out, 'result.json')
  assert.equal(args.softFail, true)
  assert.equal(args.listing, true)
})

await test('parseArgs accepts --flag=value', () => {
  const args = parseArgs(['--live', '--prompt=hello', '--lane=opencode'])
  assert.equal(args.prompt, 'hello')
  assert.equal(args.lane, 'opencode')
})

await test('parseArgs rejects an unknown flag', () => {
  assert.throws(() => parseArgs(['--live', '--bogus']), UsageError)
})

await test('checkNode accepts the supported lines and rejects the rest', () => {
  assert.doesNotThrow(() => checkNode('22.19.0'))
  assert.doesNotThrow(() => checkNode('22.21.1'))
  assert.doesNotThrow(() => checkNode('24.0.0'))
  assert.throws(() => checkNode('22.18.9'), UsageError)
  assert.throws(() => checkNode('23.4.0'), UsageError)
  assert.throws(() => checkNode('20.19.0'), UsageError)
})

await test('normalizeRequest requires a prompt', () => {
  assert.throws(() => normalizeRequest({}), /prompt is required/)
})

await test('normalizeRequest rejects auto plus an explicit model', () => {
  assert.throws(
    () => normalizeRequest({ prompt: 'x', lane: 'auto', model: 'kilo-auto/free' }),
    /requires --lane kilo or --lane opencode/,
  )
})

await test('normalizeRequest redacts before it caps', () => {
  const token = `ghp_${'a'.repeat(36)}`
  const key = '-----BEGIN PRIVATE KEY-----\nMIIBVAIBADANBgkqhkiG9w0\n-----END PRIVATE KEY-----'
  const request = normalizeRequest({
    prompt: `token ${token}\n${key}\nordinary text`,
    maxInputChars: 10_000,
  })
  assert.equal(request.redactions, 2)
  assert.match(request.prompt, /\[REDACTED\]/)
  assert.doesNotMatch(request.prompt, /ghp_/)
  assert.doesNotMatch(request.prompt, /BEGIN PRIVATE KEY/)
  assert.match(request.prompt, /ordinary text/)
})

await test('normalizeRequest caps a long prompt and records the omission', () => {
  const request = normalizeRequest({ prompt: 'x'.repeat(200), maxInputChars: 50 })
  assert.equal(request.inputTruncated, true)
  assert.equal(request.inputOmittedChars, 150)
  assert.match(request.prompt, /\[truncated 150 characters\]/)
})

await test('normalizeRequest validates numeric limits', () => {
  assert.throws(() => normalizeRequest({ prompt: 'x', maxOutputTokens: 'many' }), /integer/)
  assert.throws(() => normalizeRequest({ prompt: 'x', timeoutMs: 10 }), /between/)
})

await test('loadRequest gives a prompt/system file precedence over inline text', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'free-model-action-request-'))
  try {
    const promptFile = path.join(directory, 'prompt.txt')
    const systemFile = path.join(directory, 'system.txt')
    fs.writeFileSync(promptFile, 'prompt from file')
    fs.writeFileSync(systemFile, 'system from file')
    const request = loadRequest(parseArgs([
      '--live',
      '--prompt', 'inline prompt',
      '--prompt-file', promptFile,
      '--system', 'inline system',
      '--system-file', systemFile,
    ]))
    assert.equal(request.prompt, 'prompt from file')
    assert.equal(request.system, 'system from file')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

await test('loadRequest applies CLI flags over a request file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'free-model-action-request-'))
  try {
    const requestFile = path.join(directory, 'request.json')
    fs.writeFileSync(requestFile, JSON.stringify({
      lane: 'kilo',
      prompt: 'file prompt',
      maxOutputTokens: 10,
      softFail: false,
    }))
    const request = loadRequest(parseArgs([
      '--live',
      '--request', requestFile,
      '--lane', 'opencode',
      '--max-output-tokens', '64',
      '--soft-fail',
    ]))
    assert.equal(request.lane, 'opencode')
    assert.equal(request.prompt, 'file prompt')
    assert.equal(request.maxOutputTokens, 64)
    assert.equal(request.softFail, true)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

await test('loadRequest carries --verbose into the request', () => {
  const request = loadRequest(parseArgs(['--live', '--prompt', 'x', '--verbose']))
  assert.equal(request.verbose, true)
})

await test('capText leaves a short prompt untouched', () => {
  assert.deepEqual(capText('hello', 10), { text: 'hello', truncated: false, omitted: 0 })
})

await test('redactText catches common token spellings', () => {
  const result = redactText([
    'ghp_' + 'b'.repeat(30),
    'github_pat_' + 'c'.repeat(30),
    'sk-' + 'd'.repeat(30),
    'AKIA' + 'E'.repeat(16),
    'Authorization: Bearer abcdefghijklmnop',
    'api_key = "1234567890abcdef"',
  ].join('\n'))
  assert.equal(result.count, 6)
  assert.doesNotMatch(result.text, /ghp_|github_pat_|sk-|AKIA/)
  assert.match(result.text, /\[REDACTED\]/)
})

await test('lanePlan keeps the auto order and honors an explicit lane', () => {
  assert.deepEqual(lanePlan('auto'), ['kilo', 'opencode'])
  assert.deepEqual(lanePlan('kilo'), ['kilo'])
  assert.deepEqual(lanePlan('opencode'), ['opencode'])
})

await test('collectStream assembles Chat text, usage, and finish', async () => {
  const raw = [
    sse({ choices: [{ delta: { content: 'Hello' } }] }),
    sse({ choices: [{ delta: { content: ' world' } }] }),
    sse({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }),
  ]
  const output = await collectStream(raw, 'chat')
  assert.equal(output.text, 'Hello world')
  assert.equal(output.finish, 'stop')
  assert.equal(output.usage.totalTokens, 12)
  assert.equal(output.sawFinish, true)
  assert.equal(output.sawToolCall, false)
})

await test('collectStream reports an empty stream without inventing text', async () => {
  const output = await collectStream([], 'chat')
  assert.equal(output.text, '')
  assert.equal(output.finish, null)
  assert.equal(output.usage.totalTokens, 0)
  assert.equal(output.sawFinish, false)
})

await test('collectStream separates reasoning from the answer', async () => {
  const raw = [
    sse({ choices: [{ delta: { reasoning_content: 'thinking...' } }] }),
    sse({ choices: [{ delta: {}, finish_reason: 'length' }] }),
  ]
  const output = await collectStream(raw, 'chat')
  assert.equal(output.text, '')
  assert.equal(output.reasoningChars, 'thinking...'.length)
  assert.equal(output.finish, 'length')
})

await test('collectStream flags a tool-call-only stream', async () => {
  const raw = [
    sse({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'read', arguments: '{"filePath":"x"}' },
          }],
        },
      }],
    }),
    sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
  ]
  const output = await collectStream(raw, 'chat')
  assert.equal(output.text, '')
  assert.equal(output.sawToolCall, true)
  assert.equal(output.finish, 'tool_calls')
})

await test('writeResult creates parent directories and writes JSON', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'free-model-action-'))
  const file = path.join(directory, 'nested', 'result.json')
  const original = process.stderr.write
  process.stderr.write = () => true
  try {
    writeResult(file, { ok: true, lane: 'kilo' })
  } finally {
    process.stderr.write = original
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ok: true, lane: 'kilo' })
  fs.rmSync(directory, { recursive: true, force: true })
})

await test('fenceFor outgrows the longest backtick run', () => {
  assert.equal(fenceFor('no ticks'), '```')
  assert.equal(fenceFor('a ``` b'), '````')
  assert.equal(fenceFor('a ````` b'), '``````')
})

await test('sanitizeComment strips controls and neutralizes mentions', () => {
  const output = sanitizeComment('hi @alice\u0007\r\nnext')
  assert.equal(output, 'hi @​alice\nnext')
})

await test('formatSummary carries the successful answer and usage', () => {
  const summary = formatSummary({
    ok: true,
    lane: 'kilo',
    model: 'kilo-auto/free',
    finish: 'stop',
    text: 'hello',
    usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
  })
  assert.match(summary, /### Free model call/)
  assert.match(summary, /kilo-auto\/free/)
  assert.match(summary, /```text\nhello\n```/)
})

await test('formatSummary records the attempts of a failed call', () => {
  const summary = formatSummary({
    ok: false,
    code: 'RATE_LIMIT',
    message: 'quota',
    attempts: [{ lane: 'kilo', model: 'kilo-auto/free', ok: false, code: 'RATE_LIMIT', elapsedMs: 12 }],
  })
  assert.match(summary, /RATE_LIMIT/)
  assert.match(summary, /\| kilo \| kilo-auto\/free \| failed \| RATE_LIMIT \| 12 \|/)
})

await test('formatComment emits a marker and sanitizes mentions', () => {
  const body = formatComment({ ok: true, lane: 'kilo', model: 'm', text: 'hi @bob' })
  assert.match(body, /<!-- free-model-action -->/)
  assert.match(body, /@​bob/)
  assert.equal(formatComment({ ok: false, text: 'nope' }), '')
})

await test('formatComment caps an oversized answer below the GitHub limit', () => {
  const body = formatComment({ ok: true, text: 'x'.repeat(MAX_COMMENT_CHARS + 10_000) })
  assert.match(body, /\[comment truncated\]/)
  assert.ok(body.length < 65_536, `comment body is ${body.length} characters`)
})

if (failures.length > 0) {
  console.error(`\n${failures.length} suite(s) failed; ${passed} passed`)
  process.exitCode = 1
} else {
  console.log(`\n${passed} suite(s) passed`)
}
