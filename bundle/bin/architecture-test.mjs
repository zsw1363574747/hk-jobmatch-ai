import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeSalary, salaryShort } from '../lib/domain/salary.js'
import { projectRun } from '../lib/features/report/project.js'
import { attachJd } from '../lib/features/details/attach-jd.js'
import { rescore } from '../lib/features/search/rescore.js'
import { readPage, writePage } from '../lib/storage/page-store.js'
import { readRun, writeRun } from '../lib/storage/run-store.js'

const checks = []
function check(name, fn) {
  try {
    fn()
    checks.push({ name, ok: true })
    console.log(`[PASS] ${name}`)
  } catch (error) {
    checks.push({ name, ok: false, error })
    console.log(`[FAIL] ${name} — ${error?.message ?? error}`)
  }
}

function sampleRun() {
  return {
    schemaVersion: 3,
    runId: 'r-test-0001',
    createdAt: '2026-11-09T00:00:00.000Z',
    query: { keywords: ['product manager'] },
    profileSummary: { years: 0 },
    profile: { years: 0, skills: [], titles: [] },
    weights: { skills: 0.3, title: 0.15, domain: 0.12, location: 0.08, workType: 0.05, freshness: 0.1, experience: 0.2 },
    rules: { penalty: 0.5 },
    details: {},
    jobs: [
      {
        id: '1',
        key: 'jobsdb:1',
        source: 'jobsdb',
        title: 'Assistant Product Manager',
        company: 'Acme',
        salary: { min: 30000, max: 40000, mid: 35000, period: 'month', kind: 'probed' },
        salaryText: '≈30–40K',
        score: 80,
        tier: 'A',
        locations: ['Hong Kong'],
        experience: { requiredYears: 1, minYears: 1, maxYears: null, haveYears: 0, verdict: 'short' },
      },
      {
        id: '2',
        key: 'jobsdb:2',
        source: 'jobsdb',
        title: 'Product Manager',
        company: 'Beta',
        salary: '$50,000 – $60,000 per month',
        score: 40,
        tier: 'C',
        locations: ['Kowloon'],
      },
    ],
  }
}

check('salary: 明码字符串归一成对象', () => {
  const salary = normalizeSalary('$30,000 – $35,000 per month')
  assert.equal(salary.kind, 'explicit')
  assert.equal(salary.min, 30000)
  assert.equal(salary.max, 35000)
  assert.equal(salaryShort(salary), '30–35K')
})

check('salary: 历史对象保持对象', () => {
  const salary = normalizeSalary({ min: 25000, max: 40000, mid: 32500, period: 'month', kind: 'probed' })
  assert.equal(salary.kind, 'probed')
  assert.equal(salaryShort(salary), '≈25–40K')
})

check('salary: 面议 / null 不瞎猜', () => {
  assert.equal(normalizeSalary('Negotiable'), null)
  assert.equal(normalizeSalary(null), null)
})

check('projectRun: 纯函数、幂等、salary 永远是对象', () => {
  const run = sampleRun()
  const first = projectRun(run)
  const second = projectRun(run)
  assert.deepEqual(first, second)
  assert.equal(first.jobs[0].salary.kind, 'probed')
  assert.equal(first.jobs[1].salary.kind, 'explicit')
  assert.equal(first.jobs[0].salaryText, '≈30–40K')
  assert.equal(first.counts.A, 1)
  assert.equal(first.counts.C, 1)
})

check('projectRun: 不改 run.jobs 顺序', () => {
  const run = sampleRun()
  const before = run.jobs.map((job) => job.key)
  projectRun(run)
  assert.deepEqual(run.jobs.map((job) => job.key), before)
})

check('page-store: guardRunId 不覆盖另一轮', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobmatch-test-'))
  try {
    writePage(dir, { runId: 'r-a', jobs: [] })
    const wrote = writePage(dir, { runId: 'r-b', jobs: [] }, { guardRunId: 'r-b' })
    assert.equal(wrote, null)
    assert.equal(readPage(dir).runId, 'r-a')
    const updated = writePage(dir, { runId: 'r-a', jobs: [1] }, { guardRunId: 'r-a' })
    assert.ok(updated)
    assert.equal(readPage(dir).jobs.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('run-store: 缺失 run 给出可读错误', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobmatch-test-'))
  try {
    assert.throws(
      () => readRun(dir, 'r-missing'),
      (error) => error.code === 'E_RUN_NOT_FOUND' && String(error.hint).includes('重新搜索'),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('run-store: 写入后能读回同一 run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobmatch-test-'))
  try {
    const run = sampleRun()
    writeRun(dir, run)
    assert.equal(readRun(dir, run.runId).jobs.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('details: 手动贴 JD 写入 run.details，不丢 key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobmatch-test-'))
  try {
    const run = sampleRun()
    writeRun(dir, run)
    const result = attachJd(run.runId, { id: 'jobsdb:1', text: 'We need at least 3 years of product management experience. Build roadmap and ship features.' }, { dataDir: dir })
    assert.equal(result.ok, true)
    const saved = readRun(dir, run.runId)
    assert.ok(saved.details['jobsdb:1'].contentText.includes('3 years'))
    assert.equal(saved.jobs.find((job) => job.key === 'jobsdb:1').jdSource, 'manual')
    assert.equal(readPage(dir).runId, run.runId)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('rescore: 显式年限覆盖写进 run.profile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobmatch-test-'))
  try {
    const run = sampleRun()
    writeRun(dir, run)
    const result = rescore(run.runId, { years: 3 }, { dataDir: dir })
    assert.equal(result.ok, true)
    assert.equal(readRun(dir, run.runId).profile.years, 3)
    assert.equal(readPage(dir).runId, run.runId)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const failed = checks.filter((item) => !item.ok)
console.log(`\n${failed.length === 0 ? 'ALL PASS' : 'FAILED'} · ${checks.length} checks`)
process.exitCode = failed.length === 0 ? 0 : 1
