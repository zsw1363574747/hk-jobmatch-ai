import { state } from './core.js'

// 「点过的岗位」记在浏览器本地：换机器/清缓存会丢，但不用动 data/ 里的 run 文件。
const STORAGE_KEY = 'jobmatch.viewed.v1'
const MAX_ENTRIES = 5000

export function loadViewed() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return new Set(Array.isArray(raw) ? raw.map(String) : [])
  } catch {
    return new Set()
  }
}

function viewedSet() {
  if (!state.viewed) state.viewed = loadViewed()
  return state.viewed
}

export function isViewed(key) {
  return viewedSet().has(String(key))
}

function paintRow(id) {
  const tr = document.querySelector(`#rows tr[data-id="${CSS.escape(id)}"]`)
  if (!tr || tr.querySelector('.tag.seen')) return
  const title = tr.querySelector('.job-title')
  if (!title) return
  // 放在标题前面：标题超长会被 ellipsis 截掉，标在后面就看不见了。
  title.insertAdjacentHTML('afterbegin', '<span class="tag seen" title="你点开过这条">已看</span>')
}

/** 打开一条岗位时调用：记账 + 立刻在列表行上加「已看」。 */
export function markViewed(key) {
  const id = String(key ?? '')
  if (id === '') return
  const set = viewedSet()
  if (!set.has(id)) {
    set.add(id)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...set].slice(-MAX_ENTRIES)))
    } catch {
      // 隐私模式 / 配额满：内存里记着就够了
    }
  }
  paintRow(id)
}

/** 「新」= 发布时间在 N 天内；拿不到发布时间就不标。 */
export function isFresh(job, days = 3) {
  const published = Date.parse(job?.listedAt ?? '')
  if (!Number.isFinite(published)) return false
  return Date.now() - published <= days * 86400000 && Date.now() >= published
}
