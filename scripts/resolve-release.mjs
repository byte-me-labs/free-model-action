#!/usr/bin/env node
/**
 * Print the newest stable `vX.Y.Z` release tag for a repository.
 *
 * Upstream also publishes `*-macos-unofficial` releases after some stable
 * releases, so `/releases/latest` can point at an unofficial build. Sort the
 * stable tags ourselves instead of trusting that endpoint.
 *
 * @module scripts/resolve-release.mjs
 */
import { execFileSync } from 'node:child_process'
import process from 'node:process'

export const STABLE_TAG = /^v\d+\.\d+\.\d+$/

/** Pick the highest stable tag from `gh release list --json` records. */
export function pickStableTag(releases) {
  if (!Array.isArray(releases)) return null
  const tags = releases
    .filter(release => release !== null && typeof release === 'object')
    .filter(release => release.isDraft !== true && release.isPrerelease !== true)
    .map(release => release.tagName)
    .filter(tag => typeof tag === 'string' && STABLE_TAG.test(tag))
  tags.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  return tags.at(-1) ?? null
}

function parseArgs(argv) {
  const args = { repo: 'Ebony-Vinyl/dsh-our-free-model', limit: '100', gh: 'gh' }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[++index]
    if (value === undefined) throw new Error(`${flag} requires a value`)
    if (flag === '--repo') args.repo = value
    else if (flag === '--limit') args.limit = value
    else if (flag === '--gh') args.gh = value
    else throw new Error(`unknown flag ${flag}`)
  }
  return args
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  let raw
  try {
    raw = execFileSync(args.gh, [
      'release', 'list',
      '--repo', args.repo,
      '--limit', args.limit,
      '--json', 'tagName,isDraft,isPrerelease',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    process.stderr.write(`resolve-release: gh failed: ${error?.stderr?.toString().trim() || error?.message || error}\n`)
    return 1
  }
  let releases
  try {
    releases = JSON.parse(raw)
  } catch (error) {
    process.stderr.write(`resolve-release: invalid JSON from gh: ${error?.message ?? error}\n`)
    return 1
  }
  const tag = pickStableTag(releases)
  if (tag === null) {
    process.stderr.write(`resolve-release: no stable vX.Y.Z release found in ${args.repo}\n`)
    return 1
  }
  process.stdout.write(`${tag}\n`)
  return 0
}

const isMain = process.argv[1] !== undefined && process.argv[1].endsWith('resolve-release.mjs')
if (isMain) process.exitCode = main()
