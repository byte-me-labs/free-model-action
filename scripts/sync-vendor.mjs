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
 *     node scripts/sync-vendor.mjs --source ../dsh-our-free-model --tag v2.9.0
 *     node scripts/sync-vendor.mjs --check --tag v2.9.0
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
    tag: null,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--source') {
      if (argv[index + 1] === undefined) throw new Error('--source requires a path')
      args.source = path.resolve(argv[++index])
    } else if (flag === '--tag') {
      if (argv[index + 1] === undefined) throw new Error('--tag requires a release tag such as v2.9.0')
      args.tag = argv[++index]
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

function gitOutput(source, gitArgs) {
  return execFileSync('git', ['-C', source, ...gitArgs], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

/** Never let a tokenized HTTPS remote end up in PROVENANCE.json. */
function normalizeRemote(url) {
  const value = String(url ?? '').trim()
  if (value === '') return 'https://github.com/Ebony-Vinyl/dsh-our-free-model'
  try {
    if (/^https?:\/\//i.test(value)) {
      const parsed = new URL(value)
      parsed.username = ''
      parsed.password = ''
      return parsed.toString().replace(/\.git$/, '')
    }
  } catch { /* fall through to the raw value */ }
  return value.replace(/\.git$/, '')
}

function sourceMetadata(source, tag) {
  let version = 'unknown'
  try {
    version = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).version ?? 'unknown'
  } catch { /* the metadata is best effort */ }
  let commit = 'unknown'
  try { commit = gitOutput(source, ['rev-parse', 'HEAD']) } catch { /* not a checkout */ }
  let describe = 'unknown'
  try { describe = gitOutput(source, ['describe', '--tags', '--always']) } catch { /* not a checkout */ }
  let dirty = null
  try { dirty = gitOutput(source, ['status', '--porcelain']) !== '' } catch { /* not a checkout */ }
  let remote = 'https://github.com/Ebony-Vinyl/dsh-our-free-model'
  try {
    const url = gitOutput(source, ['remote', 'get-url', 'origin'])
    if (url !== '') remote = normalizeRemote(url)
  } catch { /* keep the known upstream */ }
  let tagCommit = null
  if (tag !== null) {
    try { tagCommit = gitOutput(source, ['rev-parse', `${tag}^{commit}`]) } catch { /* shallow checkout */ }
  }
  return { version, commit, describe, dirty, remote, tagCommit }
}

/**
 * A release sync must be reproducible: the source checkout has to be clean and
 * at the requested tag. `tagCommit` is absent in a shallow checkout that did
 * not fetch the tag ref; the package.json check below still pins the release.
 */
function verifySource(metadata, tag) {
  if (tag !== null && !/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error(`--tag ${tag} is not a stable release tag (expected vX.Y.Z)`)
  }
  if (metadata.dirty === null) {
    throw new Error('source is not a git checkout; sync from a clone of dsh-our-free-model')
  }
  if (metadata.dirty) {
    throw new Error('source checkout is dirty; commit or stash changes before syncing')
  }
  if (tag === null) return
  const expectedVersion = tag.replace(/^v/, '')
  if (/^\d+\.\d+\.\d+$/.test(expectedVersion) && metadata.version !== expectedVersion) {
    throw new Error(`tag ${tag} does not match package.json version ${metadata.version}`)
  }
  if (metadata.tagCommit !== null && metadata.commit !== 'unknown' && metadata.commit !== metadata.tagCommit) {
    throw new Error(
      `source HEAD ${metadata.commit.slice(0, 7)} is not the ${tag} commit (${metadata.tagCommit.slice(0, 7)})`,
    )
  }
  if (metadata.tagCommit === null) {
    console.error('sync-vendor: warning: tag ref not found; relying on package.json version')
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (!fs.existsSync(path.join(args.source, 'src'))) {
    throw new Error(`${args.source} does not look like a dsh-our-free-model checkout (missing src/)`)
  }

  const metadata = sourceMetadata(args.source, args.tag)
  verifySource(metadata, args.tag)

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
    let existingFiles = []
    try { existingFiles = fs.readdirSync(DEST) } catch { /* missing vendor dir is drift below */ }
    for (const existing of existingFiles) {
      if (existing.endsWith('.js') && !sources.has(existing)) drifted.push(`${existing} (stale)`)
    }
    if (args.tag !== null) {
      let releaseTag = null
      try {
        releaseTag = JSON.parse(fs.readFileSync(path.join(DEST, 'PROVENANCE.json'), 'utf8')).releaseTag ?? null
      } catch { /* missing provenance is drift */ }
      if (releaseTag !== args.tag) drifted.push(`PROVENANCE.json (releaseTag is ${releaseTag ?? 'missing'})`)
    }
    if (drifted.length > 0) {
      console.error(`vendor drift: ${drifted.join(', ')}`)
      return 1
    }
    console.log(`vendor is current with ${args.source}${args.tag === null ? '' : ` at ${args.tag}`} (${FILES.length} files)`)
    return 0
  }

  fs.mkdirSync(DEST, { recursive: true })
  for (const [file, text] of sources) {
    fs.writeFileSync(path.join(DEST, file), text)
  }
  for (const existing of fs.readdirSync(DEST)) {
    if (existing.endsWith('.js') && !sources.has(existing)) {
      fs.rmSync(path.join(DEST, existing))
      console.log(`removed stale vendored file ${existing}`)
    }
  }

  const license = path.join(ROOT, 'LICENSE')
  if (!fs.existsSync(license)) {
    fs.copyFileSync(path.join(args.source, 'LICENSE'), license)
  }

  const provenance = {
    source: metadata.remote,
    releaseTag: args.tag,
    version: metadata.version,
    commit: metadata.commit,
    describe: metadata.describe,
    dirty: metadata.dirty,
    syncedAt: new Date().toISOString(),
    files: FILES,
    notes: [
      'Vendored dependency closure of the OpenCode/Kilo wire layer.',
      'o2a.js is generated upstream; do not hand-edit it.',
      'Synced from an upstream release tag; releaseTag is the comparison key for sync-upstream.yml.',
      'Run scripts/sync-vendor.mjs --tag <tag> after updating dsh-our-free-model.',
    ],
  }
  fs.writeFileSync(path.join(DEST, 'PROVENANCE.json'), `${JSON.stringify(provenance, null, 2)}\n`)
  console.log(
    `synced ${FILES.length} files from ${args.source} (${args.tag ?? metadata.describe} @ ${metadata.commit.slice(0, 7)}, version ${metadata.version})`,
  )
  return 0
}

try {
  process.exitCode = main()
} catch (error) {
  console.error(`sync-vendor: ${error?.message ?? error}`)
  process.exitCode = 1
}
