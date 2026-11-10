import { fail } from './errors.js'
import { htmlToText } from './text.js'

const REDUX_MARKER = 'window.SEEK_REDUX_DATA = '

function toArray(value) {
  return Array.isArray(value) ? value : []
}

/**
 * 把 v5 搜索接口的 JSON 归一成 Job[]（5.6.5）：字段映射 → 丢无效 → 按 id 去重。
 */
export function normalizeSearch(json, site) {
  const items = json && Array.isArray(json.data) ? json.data : null
  if (!items || items.length === 0) {
    throw Object.assign(fail('E_EMPTY_RESULT'), { step: 'normalizeSearch' })
  }

  const seen = new Set()
  const jobs = []
  for (const item of items) {
    const id = item && item.id != null ? String(item.id) : ''
    const title = item && typeof item.title === 'string' ? item.title.trim() : ''
    if (id === '' || title === '' || seen.has(id)) continue
    seen.add(id)
    jobs.push({
      id,
      title,
      company: item.companyName ?? item.advertiser?.description ?? '',
      salaryLabel: typeof item.salaryLabel === 'string' ? item.salaryLabel : '',
      locations: toArray(item.locations).map((entry) => entry?.label).filter(Boolean),
      workTypes: toArray(item.workTypes).filter((entry) => typeof entry === 'string'),
      classifications: toArray(item.classifications)
        .map((entry) => entry?.subclassification?.description ?? entry?.classification?.description)
        .filter(Boolean),
      listedAt: typeof item.listingDate === 'string' ? item.listingDate : '',
      teaser: typeof item.teaser === 'string' ? item.teaser : '',
      url: site.jobUrl(id),
    })
  }

  return { jobs, totalCount: Number.isFinite(json?.totalCount) ? json.totalCount : 0 }
}

/**
 * 详情页解析（5.6.6）：找到 window.SEEK_REDUX_DATA 后按括号扫描取整段 JSON。
 */
export function parseSeekRedux(html) {
  const text = String(html ?? '')
  const markerIndex = text.indexOf(REDUX_MARKER)
  if (markerIndex < 0) {
    throw Object.assign(fail('E_PARSE_FAILED'), { step: 'parseSeekRedux' })
  }

  let start = text.indexOf('{', markerIndex + REDUX_MARKER.length)
  if (start < 0) {
    throw Object.assign(fail('E_PARSE_FAILED'), { step: 'parseSeekRedux' })
  }

  let depth = 0
  let inString = false
  let escaped = false
  let end = -1
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        end = index + 1
        break
      }
    }
  }
  if (end < 0) {
    throw Object.assign(fail('E_PARSE_FAILED'), { step: 'parseSeekRedux' })
  }

  let payload
  try {
    payload = JSON.parse(text.slice(start, end))
  } catch {
    throw Object.assign(fail('E_PARSE_FAILED'), { step: 'parseSeekRedux' })
  }

  const job = payload?.jobdetails?.result?.job
  if (!job || typeof job !== 'object') {
    throw Object.assign(fail('E_JOB_GONE'), { step: 'parseSeekRedux' })
  }

  const contentHtml = typeof job.content === 'string' && job.content !== '' ? job.content : job.content2 ?? ''
  const contentText = htmlToText(contentHtml)

  const profile = payload?.jobdetails?.result?.companyProfile
  const companyProfile =
    profile && typeof profile === 'object'
      ? {
          id: profile.id != null ? String(profile.id) : '',
          name: typeof profile.name === 'string' ? profile.name : '',
          slug: typeof profile.companyNameSlug === 'string' ? profile.companyNameSlug : '',
          logo: typeof profile.branding?.logo === 'string' ? profile.branding.logo : '',
          industry: typeof profile.overview?.industry === 'string' ? profile.overview.industry : '',
          size: typeof profile.overview?.size?.description === 'string' ? profile.overview.size.description : '',
          website: typeof profile.overview?.website === 'string' ? profile.overview.website : '',
          description: toArray(profile.overview?.description?.paragraphs).filter(Boolean).join('\n\n'),
          url:
            typeof profile.companyNameSlug === 'string' && profile.companyNameSlug !== ''
              ? `https://hk.jobsdb.com/companies/${profile.companyNameSlug}`
              : '',
        }
      : null

  return {
    id: job.id != null ? String(job.id) : '',
    title: typeof job.title === 'string' ? job.title : '',
    company: job.advertiser?.name ?? '',
    salary: job.salary?.label ?? '',
    location: job.location?.label ?? '',
    classifications: toArray(job.classifications).map((entry) => entry?.label).filter(Boolean),
    workTypes: toArray(job.workTypes)
      .map((entry) => (typeof entry === 'string' ? entry : entry?.label))
      .filter(Boolean),
    listedAt: typeof job.listedAt === 'string' ? job.listedAt : '',
    expiresAt: typeof job.expiresAt === 'string' ? job.expiresAt : '',
    isExpired: job.isExpired === true,
    contentHtml,
    contentText,
    contentChars: contentText.length,
    companyProfile,
  }
}
