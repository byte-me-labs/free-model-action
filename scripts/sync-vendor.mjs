#!/usr/bin/env node
/**
 * Copy the wire modules this action needs out of a dsh-our-free-model checkout.
 *
 * The action is self-contained so it can run from any repository without a
 * second checkout. That means the small dependency closure is vendored under
 * `vendor/ofm/`. This script is the only supported way to update it:
 *
 *     node scripts/sync-vendor.mjs
 *     node scripts/sync-vendor.mjs --source ../dsh-our-free-model
 *     node scripts/sync-vendor.mjs --check
 *
 * It verifies that every relative import in the closure points at another
 * vendored file. A new upstream import fails the sync instead of producing a
 * runtime MODULE_NOT_FOUND at the first lane call.
 *
 * @module scripts/sync-vendor.mjs
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const DEST = path.join(ROOT, 'vendor', 'ofm')

/** Dependency closure of `kilo.js` + `http.js` + `upstream.js` + `stream.js`. */
const FILES = [
  'o2a.js',
  'upstream.js',
  'store.js',
  'open-external.js',
  'bun-fetch.js',
  'egress.js',
  'http.js',
  'kilo.js',
  'stream.js',
]

function parseArgs(argv) {
  const args = {
    source: path.resolve(ROOT, '..', 'dsh-our-free-model'),
    check: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--source') {
      if (argv[index + 1] === undefined) throw new Error('--source requires a path')
      args.source = path.resolve(argv[++index])
    } else if (flag === '--check') {
      args.check = true
    } else {
      throw new Error(`unknown flag ${flag}`)
    }
  }
  return args
}

function readSource(source, file) {
  const absolute = path.join(source, 'src', file)
  try {
    return fs.readFileSync(absolute, 'utf8')
  } catch (error) {
    throw new Error(`cannot read ${absolute}: ${error?.message ?? error}`)
  }
}

/** Every relative import must resolve inside the vendored file set. */
function verifyImports(file, text) {
  const pattern = /(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g
  let match
  while ((match = pattern.exec(text)) !== null) {
    const target = match[1]
    if (!target.startsWith('./')) {
      throw new Error(`${file}: unsupported relative import ${target} (only ./<file> is vendored)`)
    }
    const bare = target.slice(2)
    if (bare.includes('/')) {
      throw new Error(`${file}: import ${target} points into a subdirectory this action does not vendor`)
    }
    if (!FILES.includes(bare)) {
      throw new Error(`${file}: import ${target} is not in the vendored file list; add it or stop using it`)
    }
  }
}

function sourceMetadata(source) {
  let version = 'unknown'
  try {
    version = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).version ?? 'unknown'
  } catch { /* the metadata is best effort */ }
  let commit = 'unknown'
  try {
    commit = execFileSync('git', ['-C', source, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch { /* not a checkout */ }
  let remote = 'https://github.com/Ebony-Vinyl/dsh-our-free-model'
  try {
    const url = execFileSync('git', ['-C', source, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim()
    if (url !== '') remote = url.replace(/\.git$/, '')
  } catch { /* keep the known upstream */ }
  return { version, commit, remote }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (!fs.existsSync(path.join(args.source, 'src'))) {
    throw new Error(`${args.source} does not look like a dsh-our-free-model checkout (missing src/)`)
  }

  const sources = new Map()
  for (const file of FILES) {
    const text = readSource(args.source, file)
    verifyImports(file, text)
    sources.set(file, text)
  }

  if (args.check) {
    const drifted = []
    for (const [file, text] of sources) {
      const vendored = path.join(DEST, file)
      let current = null
      try { current = fs.readFileSync(vendored, 'utf8') } catch { /* missing is drift */ }
      if (current !== text) drifted.push(file)
    }
    if (drifted.length > 0) {
      console.error(`vendor drift: ${drifted.join(', ')}`)
      return 1
    }
    console.log(`vendor is current with ${args.source} (${FILES.length} files)`)
    return 0
  }

  fs.mkdirSync(DEST, { recursive: true })
  for (const [file, text] of sources) {
    fs.writeFileSync(path.join(DEST, file), text)
  }

  const license = path.join(ROOT, 'LICENSE')
  if (!fs.existsSync(license)) {
    fs.copyFileSync(path.join(args.source, 'LICENSE'), license)
  }

  const metadata = sourceMetadata(args.source)
  const provenance = {
    source: metadata.remote,
    version: metadata.version,
    commit: metadata.commit,
    syncedAt: new Date().toISOString(),
    files: FILES,
    notes: [
      'Vendored dependency closure of the OpenCode/Kilo wire layer.',
      'o2a.js is generated upstream; do not hand-edit it.',
      'Run scripts/sync-vendor.mjs after updating dsh-our-free-model.',
    ],
  }
  fs.writeFileSync(path.join(DEST, 'PROVENANCE.json'), `${JSON.stringify(provenance, null, 2)}\n`)
  console.log(`synced ${FILES.length} files from ${args.source} (${metadata.version} @ ${metadata.commit})`)
  return 0
}

try {
  process.exitCode = main()
} catch (error) {
  console.error(`sync-vendor: ${error?.message ?? error}`)
  process.exitCode = 1
}
