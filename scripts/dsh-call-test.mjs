#!/usr/bin/env node
/**
 * Offline tests for the dsh-based caller.
 *
 * The end-to-end cases spawn a fake `dsh` wrapper that replays a recorded
 * ndjson stream, so no network, plugin, or quota is involved.
 *
 * @module scripts/dsh-call-test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  FREE_COMBO,
  LANE_MODELS,
  UsageError,
  capText,
  mergeSettings,
  modelPatch,
  parseEvents,
  redactText,
  resultFromRun,
  selectionFor,
} from './dsh-call.mjs'
import { formatComment, formatSummary, sanitizeComment } from './emit-result.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, 'dsh-call.mjs')
const tests = []
function test(name, fn) { tests.push({ name, fn }) }

const SUCCESS_EVENTS = [
  { type: 'session', sessionId: 'session-test', cwd: '/tmp' },
  { type: 'status', phase: 'turn_start', turn: 1 },
  { type: 'text', text: 'PONG' },
  { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 } },
  { type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } },
  { type: 'final', sessionId: 'session-test', reason: { kind: 'completed' }, text: 'PONG' },
]
const ERROR_EVENTS = [
  { type: 'session', sessionId: 'session-error', cwd: '/tmp' },
  { type: 'turn_end', reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'no route' } } },
  { type: 'final', sessionId: 'session-error', reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'no route' } }, text: '' },
]

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function writeFakeDsh(dir) {
  const fake = path.join(dir, 'fake-dsh.mjs')
  fs.writeFileSync(fake, `
import fs from 'node:fs'
let input = ''
for await (const chunk of process.stdin) input += chunk
fs.writeFileSync(process.env.FAKE_STDIN, input)
process.stdout.write(fs.readFileSync(process.env.FAKE_EVENTS, 'utf8'))
process.exit(Number(process.env.FAKE_EXIT ?? '0'))
`)
  if (process.platform === 'win32') {
    const wrapper = path.join(dir, 'fake-dsh.cmd')
    fs.writeFileSync(wrapper, `@echo off\r\nnode "%~dp0fake-dsh.mjs" %*\r\n`)
    return wrapper
  }
  const wrapper = path.join(dir, 'fake-dsh')
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec node "$(dirname "$0")/fake-dsh.mjs" "$@"\n`)
  fs.chmodSync(wrapper, 0o755)
  return wrapper
}

function runCli({ args, home, runnerTemp, events, exitCode = 0, stdinFile, extraEnv = {} }) {
  const eventsFile = path.join(runnerTemp, 'fake-events.ndjson')
  fs.writeFileSync(eventsFile, `${events.map(event => JSON.stringify(event)).join('\n')}\n`)
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DSH_HOME: home,
      RUNNER_TEMP: runnerTemp,
      FAKE_EVENTS: eventsFile,
      FAKE_STDIN: stdinFile ?? path.join(runnerTemp, 'fake-stdin.txt'),
      FAKE_EXIT: String(exitCode),
      ...extraEnv,
    },
  })
  return result
}

function readResult(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

test('selection maps lanes to provider models', () => {
  assert.deepEqual(selectionFor('auto', null), { lane: 'auto', model: FREE_COMBO, source: 'combo' })
  assert.deepEqual(selectionFor('kilo', null), { lane: 'kilo', model: LANE_MODELS.kilo, source: 'default' })
  assert.deepEqual(selectionFor('opencode', null), { lane: 'opencode', model: LANE_MODELS.opencode, source: 'default' })
  assert.deepEqual(selectionFor('auto', 'combo:mine'), { lane: 'auto', model: 'combo:mine', source: 'explicit' })
  assert.throws(() => selectionFor('nope', null), UsageError)
})

test('mergeSettings preserves unrelated keys and owns the gha combo', () => {
  const merged = mergeSettings({
    forward: { enabled: true },
    combos: [{ id: 'combo:mine', models: ['x'] }, { id: FREE_COMBO, models: ['old'], strategy: 'round-robin' }],
  }, 900)
  assert.equal(merged.defaultMaxTokens, 900)
  assert.deepEqual(merged.forward, { enabled: true })
  assert.deepEqual(merged.combos.find(combo => combo.id === 'combo:mine'), { id: 'combo:mine', models: ['x'] })
  const gha = merged.combos.find(combo => combo.id === FREE_COMBO)
  assert.deepEqual(gha.models, ['kilo-auto/free', 'deepseek-v4.1-flash-free', 'glm-5.3-flash-free'])
  assert.equal(gha.strategy, 'fallback')
  assert.equal(gha.enabled, true)
})

test('mergeSettings tolerates a missing or malformed document', () => {
  assert.equal(mergeSettings(null, 1200).defaultMaxTokens, 1200)
  assert.equal(mergeSettings([], 1200).defaultMaxTokens, 1200)
  assert.equal(mergeSettings({ combos: 'nope' }, 1200).combos.length, 1)
})

test('modelPatch quotes the provider and model', () => {
  const patch = modelPatch({ model: 'combo:gha' })
  assert.match(patch, /provider: "our-free-model"/)
  assert.match(patch, /model: "combo:gha"/)
})

test('parseEvents reads the terminal final and step usage', () => {
  const parsed = parseEvents(SUCCESS_EVENTS.map(event => JSON.stringify(event)).join('\n'))
  assert.equal(parsed.text, 'PONG')
  assert.equal(parsed.sessionId, 'session-test')
  assert.deepEqual(parsed.usage, { inputTokens: 10, outputTokens: 1, totalTokens: 11 })
  assert.equal(parsed.final.reason.kind, 'completed')
})

test('parseEvents falls back to the last text event and ignores junk', () => {
  const parsed = parseEvents('not json\n{"type":"text","text":"hello"}\n{"type":"final","reason":{"kind":"aborted"}}')
  assert.equal(parsed.text, 'hello')
  assert.equal(parsed.final.reason.kind, 'aborted')
})

test('resultFromRun accepts a completed answer', () => {
  const result = resultFromRun({
    selection: selectionFor('auto', null),
    parsed: parseEvents(SUCCESS_EVENTS.map(event => JSON.stringify(event)).join('\n')),
    process: { code: 0, signal: null, stderr: '', timedOut: false, error: null, elapsedMs: 5 },
    startedAt: Date.now() - 50,
  })
  assert.equal(result.ok, true)
  assert.equal(result.text, 'PONG')
  assert.equal(result.finish, 'completed')
  assert.equal(result.usage.totalTokens, 11)
  assert.equal(result.code, undefined)
})

test('resultFromRun rejects an empty completion', () => {
  const result = resultFromRun({
    selection: selectionFor('kilo', null),
    parsed: parseEvents('{"type":"final","reason":{"kind":"completed"},"text":""}'),
    process: { code: 0, signal: null, stderr: '', timedOut: false, error: null, elapsedMs: 5 },
    startedAt: Date.now(),
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'EMPTY_RESPONSE')
})

test('resultFromRun maps a lane error and a timeout', () => {
  const failed = resultFromRun({
    selection: selectionFor('opencode', null),
    parsed: parseEvents(ERROR_EVENTS.map(event => JSON.stringify(event)).join('\n')),
    process: { code: 1, signal: null, stderr: 'dsh: TRANSPORT: no route', timedOut: false, error: null, elapsedMs: 5 },
    startedAt: Date.now(),
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'TRANSPORT')
  assert.equal(failed.message, 'no route')

  const timedOut = resultFromRun({
    selection: selectionFor('auto', null),
    parsed: { events: [], final: null, usage: null, sessionId: null, text: '' },
    process: { code: null, signal: 'SIGTERM', stderr: '', timedOut: true, error: null, elapsedMs: 5 },
    startedAt: Date.now(),
  })
  assert.equal(timedOut.code, 'TIMEOUT')
})

test('redactText strips common credentials and capText truncates', () => {
  const redacted = redactText('token ghp_abcdefghijklmnopqrstuvwxyz0123 and sk-abcdefghijklmnopqrstuvwx')
  assert.equal(redacted.count, 2)
  assert.doesNotMatch(redacted.text, /ghp_abc/)
  assert.doesNotMatch(redacted.text, /sk-abc/)
  const capped = capText('abcdef', 3)
  assert.equal(capped.truncated, true)
  assert.match(capped.text, /^abc/)
})

test('emit-result formats summaries and sanitized comments', () => {
  const result = { ok: true, lane: 'auto', model: 'combo:gha', text: 'hello @user', finish: 'completed', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } }
  assert.match(formatSummary(result), /hello @user/)
  assert.match(formatComment(result), /hello @​user/)
  assert.equal(sanitizeComment('a\u0007b'), 'ab')
  assert.equal(formatComment({ ok: false, text: 'x' }), '')
})

test('CLI end-to-end writes settings, patch, result, and events', () => {
  const home = tempDir('ofm-home-')
  const runnerTemp = tempDir('ofm-run-')
  const out = path.join(runnerTemp, 'result.json')
  const events = path.join(runnerTemp, 'events.ndjson')
  const stdinFile = path.join(runnerTemp, 'task.txt')
  const dsh = writeFakeDsh(runnerTemp)
  const args = ['--lane', 'auto', '--prompt', 'token ghp_abcdefghijklmnopqrstuvwxyz0123', '--out', out, '--events', events, '--dsh', dsh, '--verbose']
  const proc = runCli({ args, home, runnerTemp, events: SUCCESS_EVENTS, stdinFile })
  assert.equal(proc.status, 0, proc.stderr)
  const result = readResult(out)
  assert.equal(result.ok, true)
  assert.equal(result.text, 'PONG')
  assert.equal(result.redactions, 1)
  assert.match(fs.readFileSync(stdinFile, 'utf8'), /\[REDACTED\]/)
  assert.equal(fs.readFileSync(events, 'utf8'), `${SUCCESS_EVENTS.map(event => JSON.stringify(event)).join('\n')}\n`)

  const settings = JSON.parse(fs.readFileSync(path.join(home, 'our-free-model', 'settings.json'), 'utf8'))
  assert.equal(settings.defaultMaxTokens, 1200)
  assert.equal(settings.combos.find(combo => combo.id === FREE_COMBO).enabled, true)
  const patch = fs.readFileSync(path.join(runnerTemp, 'free-model-action-model.yml'), 'utf8')
  assert.match(patch, /model: "combo:gha"/)
})

test('CLI honors explicit models and soft-fail', () => {
  const home = tempDir('ofm-home-')
  const runnerTemp = tempDir('ofm-run-')
  const out = path.join(runnerTemp, 'result.json')
  const dsh = writeFakeDsh(runnerTemp)
  const args = ['--lane', 'auto', '--model', 'kilo-auto/free', '--prompt', 'hi', '--out', out, '--dsh', dsh]
  const proc = runCli({ args, home, runnerTemp, events: SUCCESS_EVENTS })
  assert.equal(proc.status, 0, proc.stderr)
  const patch = fs.readFileSync(path.join(runnerTemp, 'free-model-action-model.yml'), 'utf8')
  assert.match(patch, /model: "kilo-auto\/free"/)

  const failed = runCli({
    args: ['--prompt', 'hi', '--out', out, '--dsh', dsh, '--soft-fail'],
    home,
    runnerTemp,
    events: ERROR_EVENTS,
    exitCode: 1,
  })
  assert.equal(failed.status, 0, failed.stderr)
  assert.equal(readResult(out).ok, false)

  const strict = runCli({
    args: ['--prompt', 'hi', '--out', out, '--dsh', dsh],
    home,
    runnerTemp,
    events: ERROR_EVENTS,
    exitCode: 1,
  })
  assert.equal(strict.status, 1)
})

test('CLI rejects a missing prompt', () => {
  const home = tempDir('ofm-home-')
  const runnerTemp = tempDir('ofm-run-')
  const dsh = writeFakeDsh(runnerTemp)
  const proc = runCli({ args: ['--out', path.join(runnerTemp, 'result.json'), '--dsh', dsh], home, runnerTemp, events: SUCCESS_EVENTS })
  assert.equal(proc.status, 2)
  assert.match(proc.stderr, /prompt is required/)
})

const failures = []
for (const { name, fn } of tests) {
  try {
    await fn()
    process.stdout.write(`ok - ${name}\n`)
  } catch (error) {
    failures.push({ name, error })
    process.stdout.write(`not ok - ${name}\n`)
    process.stdout.write(`${error?.stack ?? error}\n`)
  }
}
process.stdout.write(`\n${tests.length - failures.length}/${tests.length} passed\n`)
if (failures.length > 0) process.exitCode = 1
