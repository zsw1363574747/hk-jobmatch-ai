#!/usr/bin/env node
/**
 * 重新抓离线样本（会覆盖 bundle/data/fixtures/*.json）。
 *
 *   node --use-system-ca bundle/bin/capture-fixtures.mjs
 *
 * --use-system-ca 是为了兼容有 TLS 中间人的机器；没有代理时直接 node 也能跑。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIR = join(HERE, '..', 'data', 'fixtures')
const KEYWORD = process.argv[2] ?? 'data analyst'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

const DETAIL_QUERY = `query JobDetail($id: ID!) {
  jobDetails(id: $id) {
    job {
      id title abstract content isExpired
      advertiser { name }
      salary { label }
      location { label }
      classifications { label(languageCode: "en") }
      listedAt { dateTimeUtc }
    }
  }
}`

await mkdir(DIR, { recursive: true })

const searchUrl = `https://hk.jobsdb.com/api/jobsearch/v5/search?siteKey=HK-Main&sourcesystem=houston&keywords=${encodeURIComponent(KEYWORD)}&page=1&pageSize=30`
const searchResponse = await fetch(searchUrl, { headers: { 'user-agent': UA, accept: 'application/json', referer: 'https://hk.jobsdb.com/' } })
if (!searchResponse.ok) throw new Error(`search HTTP ${searchResponse.status}`)
const searchText = await searchResponse.text()
const searchJson = JSON.parse(searchText)
await writeFile(join(DIR, 'jobsdb-search.json'), searchText, 'utf8')

const firstId = searchJson?.data?.[0]?.id
if (!firstId) throw new Error('搜索没返回岗位，fixtures 没更新')
const detailResponse = await fetch('https://hk.jobsdb.com/graphql', {
  method: 'POST',
  headers: {
    'user-agent': UA,
    'content-type': 'application/json',
    accept: 'application/json',
    origin: 'https://hk.jobsdb.com',
    referer: 'https://hk.jobsdb.com/',
    'x-custom-features': 'application/features.seek.all+json',
  },
  body: JSON.stringify({ query: DETAIL_QUERY, variables: { id: String(firstId) } }),
})
if (!detailResponse.ok) throw new Error(`graphql HTTP ${detailResponse.status}`)
const detailText = await detailResponse.text()
await writeFile(join(DIR, 'jobsdb-detail.json'), detailText, 'utf8')

console.log(JSON.stringify({
  ok: true,
  keyword: KEYWORD,
  jobs: searchJson.data.length,
  jobId: firstId,
  searchBytes: searchText.length,
  detailBytes: detailText.length,
}))
