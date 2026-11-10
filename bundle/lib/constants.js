// 全部常量集中在这里；core 只读常量，不读环境变量。
export const SEARCH_BASE = 'https://hk.jobsdb.com/api/jobsearch/v5/search'
export const JOB_URL = 'https://hk.jobsdb.com/job/{id}'
export const SITE_KEY = 'HK-Main'
export const SOURCE_SYSTEM = 'houston'

export const PAGE_SIZE = 30
export const MAX_PAGES = 3
export const MAX_DETAILS = 30
export const REQUEST_GAP_MS = 1200
export const FETCH_TIMEOUT_MS = 15000
export const USER_AGENT = 'jobmatch/1.0 (+local)'

export const TIER_A = 50
export const TIER_B = 40
export const TIER_C = 30

// 权重和必须为 1；UI 可以让用户改，服务端会再归一化一次。
export const WEIGHTS = Object.freeze({
  skills: 0.3,
  title: 0.15,
  domain: 0.12,
  location: 0.08,
  workType: 0.05,
  freshness: 0.1,
  experience: 0.2,
})

export const WEIGHT_KEYS = Object.freeze(['skills', 'title', 'domain', 'location', 'workType', 'freshness', 'experience'])

/**
 * 经验门槛：岗位要求 > 简历年限时，整条分数乘 penalty（门槛不满足就整体降分）；
 * 要求没写清楚时不惩罚（unknown=1），不拿「未知」当「不达标」。
 */
export const EXPERIENCE_RULES = Object.freeze({
  penalty: 0.5,
  meet: 1,
  short: 0,
  unknown: 1,
})

export const FRESHNESS = Object.freeze([
  { maxDays: 7, value: 1 },
  { maxDays: 14, value: 0.7 },
  { maxDays: 30, value: 0.4 },
  { maxDays: Infinity, value: 0 },
])

export const MIN_RESUME_CHARS = 80
export const MAX_RESUME_CHARS = 20000
export const MAX_SKILLS = 30
export const MAX_TITLES = 8

export const RUN_DIR = 'data/runs'
export const LATEST_PATH = 'data/latest.json'

export const HOST = '127.0.0.1'
export const PORT = 7788
