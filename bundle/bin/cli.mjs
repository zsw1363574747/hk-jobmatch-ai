#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fail, toError } from '../lib/errors.js'
import { loadLexicon } from '../lib/features/resume/lexicon.js'
import { extractResumeText, parseProfile } from '../lib/features/resume/service.js'
import { insight, loadDetails, news, report, search, translateJob, attachJd, rescore, sources, locations, probe, browserLogin, salaryProbe, salaryPrecise, session, salaryReport, salaryBands } from '../lib/service.js'
import { addEntry, recall, seedStore, stats } from '../lib/memory.js'

const BUNDLE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

function parseFlags(argv) {
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next
      index += 1
    } else {
      flags[key] = 'true'
    }
  }
  return flags
}

function readInput(flags) {
  const parse = (raw) => {
    try {
      return JSON.parse(raw)
    } catch {
      throw Object.assign(fail('E_BAD_PARAM'), { step: 'readInput', expected: 'JSON object' })
    }
  }
  if (typeof flags.input === 'string' && flags.input !== 'true') return parse(flags.input)
  if (typeof flags['input-file'] === 'string') return parse(readFileSync(flags['input-file'], 'utf8'))
  return {}
}

async function run() {
  const [command, ...rest] = process.argv.slice(2)
  const flags = parseFlags(rest)
  const dataDir = flags['data-dir'] ?? join(BUNDLE_DIR, '..', 'test', 'tmp', 'data')
  const input = readInput(flags)

  if (command === 'resume') {
    const resume = extractResumeText(input)
    const lexicon = loadLexicon(join(BUNDLE_DIR, 'data', 'lexicon.json'))
    const profile = parseProfile(resume.text, lexicon)
    return { ok: true, ...resume, profile }
  }
  if (command === 'search') return search(input, { dataDir })
  if (command === 'jobs') return loadDetails(input.runId, { dataDir, ids: input.ids, limit: input.limit, all: input.all === true, parallel: input.parallel, withProfile: input.withProfile, sort: input.sort })
  if (command === 'jd') return attachJd(input.runId, input, { dataDir })
  if (command === 'rescore') return rescore(input.runId, input, { dataDir })
  if (command === 'report') return report(input.runId, input.verdicts, { dataDir })
  if (command === 'insight') return insight(input.runId, { dataDir, allRuns: input.allRuns === true })
  if (command === 'news') return news(input.company, { limit: input.limit })
  if (command === 'translate') return translateJob(input.runId, input.jobId, input.field, { dataDir })
  if (command === 'sources') return sources()
  if (command === 'locations') return locations()
  if (command === 'probe') return probe(input)
  if (command === 'browser-login') return browserLogin(input)
  if (command === 'salary') return salaryProbe(input.runId, input, { dataDir })
  if (command === 'salary-precise') return salaryPrecise(input.runId, input, { dataDir })
  if (command === 'session') return session()
  if (command === 'salary-report') return salaryReport(input, { dataDir })
  if (command === 'salary-bands') return salaryBands(input, { dataDir })
  if (command === 'memory') {
    const action = input.action ?? 'recall'
    if (action === 'add') return { ok: true, entry: addEntry(dataDir, input) }
    if (action === 'recall') return { ok: true, ...recall(dataDir, input) }
    if (action === 'stats') return { ok: true, ...stats(dataDir) }
    if (action === 'seed') {
      return { ok: true, ...seedStore(dataDir, join(BUNDLE_DIR, 'data', 'memory-seed.jsonl')) }
    }
    throw Object.assign(fail('E_BAD_PARAM'), { step: 'memory', expected: 'add|recall|stats|seed' })
  }

  throw Object.assign(new Error('unknown command'), { code: 'E_BAD_PARAM' })
}

try {
  const result = await run()
  process.stdout.write(`${JSON.stringify(result)}\n`)
} catch (error) {
  const failure = toError(error)
  process.stdout.write(`${JSON.stringify(failure)}\n`)
  process.exitCode = 1
}
