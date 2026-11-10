/**
 * 劳工处「互动就业服务」jobs.gov.hk 适配器。
 *
 * 站点是个老式 ASP.NET WebForm：搜索必须先 GET 拿 __RequestVerificationToken，
 * 再带着 cookie POST 到 /0/en/jobseeker/jobsearch/simple/。用 fetch 直接 POST
 * 会 302 到 404 页，所以这里改用「真浏览器里发同源请求」——
 * 一次 CDP 会话里搜完、连详情一起抓回来，省得反复启动浏览器。
 *
 * 返回的 JD 正文来自 jobCard 弹层的 innerText，已在页面里清过空白。
 */
import { renderPage } from './browser.js'

export const SOURCE_ID = 'govhk'
export const SOURCE_LABEL = '劳工处 jobs.gov.hk'

const QUICKVIEW = 'https://www.jobs.gov.hk/0/en/jobseeker/jobsearch/quickview/fulltime_na/?direct=False&page=1'

function buildScript(keywords, detailLimit, waitMs) {
  const keyword = JSON.stringify(String(keywords))
  return `(async () => {
    const KEYWORD = ${keyword};
    const DETAIL_LIMIT = ${detailLimit};
    const tokenInput = document.querySelector('[name="__RequestVerificationToken"]');
    if (!tokenInput) return JSON.stringify({ error: 'no-token' });
    const body = new URLSearchParams();
    body.set('__RequestVerificationToken', tokenInput.value);
    body.set('Criteria.searchField', KEYWORD);
    body.set('Criteria.searchByOption', '1');
    body.set('SearchFor', 'fulltime_na');
    body.set('RefineSearch', 'True');
    body.set('searchKeyword', ',');
    body.set('Criteria.displayMoreVac', 'false');
    body.set('Criteria.filterId', '');
    body.set('Criteria.specEmpProgram', '');
    const response = await fetch('/0/en/jobseeker/jobsearch/simple/', {
      method: 'POST',
      body,
      credentials: 'include',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const html = await response.text();
    if (html.length < 5000) return JSON.stringify({ error: 'search-failed', status: response.status, len: html.length });
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const cards = [...doc.querySelectorAll('[data-jobcard]')].map((el, index) => {
      const titleEl = el.querySelector('.d-flex > div');
      const salaryEl = el.querySelector('.icon_salary');
      const addrEl = el.querySelector('.icon_address');
      const orderEl = el.querySelector('[data-ordno]') || el.querySelector('input[id^="ord_no_"]');
      const order = orderEl ? (orderEl.getAttribute('data-ordno') || orderEl.value || '') : '';
      return {
        index: index + 1,
        title: titleEl ? titleEl.textContent.trim() : '',
        salary: salaryEl ? salaryEl.textContent.trim() : '',
        address: addrEl ? addrEl.textContent.trim() : '',
        order,
        card: el.getAttribute('data-jobcard') || '',
      };
    });
    const details = {};
    for (const card of cards.slice(0, DETAIL_LIMIT)) {
      if (!card.card) continue;
      try {
        const detailResponse = await fetch(card.card.replace(/&amp;/g, '&'), {
          method: 'POST',
          credentials: 'include',
          // 少了这个头，服务端会把请求当成普通页面导航，返回整个搜索页而不是职位卡。
          headers: { 'x-requested-with': 'XMLHttpRequest' },
        });
        const detailHtml = await detailResponse.text();
        const detailDoc = new DOMParser().parseFromString(detailHtml, 'text/html');
        for (const junk of ['script', 'style', 'nav', 'header', 'footer', '#mobile-navbar', '#menunav', '.dropdown-menu']) {
          detailDoc.querySelectorAll(junk).forEach((node) => node.remove());
        }
        const text = (detailDoc.body ? detailDoc.body.textContent : '') || '';
        details[card.order] = text
          .replace(/[ \\t]+/g, ' ')
          .replace(/\\n\\s*\\n+/g, '\\n')
          .trim();
      } catch (error) {
        details[card.order] = '';
      }
      await new Promise((resolve) => setTimeout(resolve, ${waitMs}));
    }
    return JSON.stringify({ url: response.url, count: cards.length, cards, details });
  })()`
}

/**
 * 政府职位卡里除了 JD，还带一堆「点此打印 / 最低工资法例解释」的样板文字。
 * 这里只留 Job Title → Remarks 这一段，顺带把首尾的导航碎屑切掉。
 */
export function cleanJobCard(raw) {
  let text = String(raw ?? '').replace(/\r\n/g, '\n').trim()
  if (text === '') return ''
  // 先把每行首尾空白抹掉，后面的标记匹配就不受缩进影响。
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
  const startCandidates = ['Job Title:', 'No.:'].map((marker) => text.indexOf(marker)).filter((index) => index >= 0)
  const start = startCandidates.length > 0 ? Math.min(...startCandidates) : 0
  const endMarkers = ['\nPrevious Job', '\nNext Job', '\nPoints-to-Note', '\nHow to Apply?', '\nNote for Job Seekers:']
  let end = text.length
  for (const marker of endMarkers) {
    const index = text.indexOf(marker, start)
    if (index >= 0 && index < end) end = index
  }
  text = text.slice(start, end)
  return text
    .split('\n')
    .filter((line, index, lines) => line !== '' || (index > 0 && lines[index - 1] !== ''))
    .join('\n')
    .trim()
}

export async function search(options = {}) {  const keywords = Array.isArray(options.keywords) ? options.keywords.join(' ') : String(options.keywords ?? '')
  const detailLimit = Math.max(0, Math.min(20, Number(options.detailLimit ?? 6)))
  const started = Date.now()
  let raw
  try {
    raw = await renderPage({
      url: QUICKVIEW,
      timeoutMs: options.timeoutMs ?? 40000,
      settleMs: 1500,
      profile: options.profile,
      executable: options.executable,
      evaluate: buildScript(keywords, detailLimit, 150),
    })
  } catch (error) {
    return { source: SOURCE_ID, jobs: [], warnings: [{ code: 'E_BROWSER', note: String(error?.message ?? error) }], ms: Date.now() - started }
  }

  let payload
  try {
    payload = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    return { source: SOURCE_ID, jobs: [], warnings: [{ code: 'E_PARSE_FAILED', note: 'govhk payload' }], ms: Date.now() - started }
  }
  if (!payload || payload.error) {
    const note = payload?.error === 'no-token' ? '页面结构变了（找不到 token）' : `搜索没返回结果 (${payload?.status ?? '?'})`
    return { source: SOURCE_ID, jobs: [], warnings: [{ code: 'E_HTTP_STATUS', note }], ms: Date.now() - started }
  }

  const jobs = (payload.cards ?? [])
    .filter((card) => card.title)
    .map((card) => {
      const order = String(card.order ?? '')
      const text = cleanJobCard((payload.details ?? {})[order] ?? '')
      const employer = (text.match(/Company \/ Employer Name:\s*\n?\s*([^\n]+)/i) ?? [])[1] ?? ''
      return {
        key: `${SOURCE_ID}:${order || card.index}`,
        source: SOURCE_ID,
        sourceLabel: SOURCE_LABEL,
        nativeId: order || String(card.index),
        id: order || String(card.index),
        title: card.title,
        company: employer.trim() || '劳工处登记雇主',
        salaryLabel: card.salary,
        locations: card.address ? [card.address] : [],
        workTypes: [],
        classifications: [],
        listedAt: '',
        teaser: text.slice(0, 240),
        url: card.card ? `https://www.jobs.gov.hk${card.card.replace(/&amp;/g, '&')}` : '',
        detailRef: { order, card: card.card },
        detail: text
          ? { contentText: text, contentChars: text.length, source: 'html', lite: false, url: '' }
          : null,
      }
    })

  return { source: SOURCE_ID, jobs, totalCount: jobs.length, warnings: [], ms: Date.now() - started }
}

export async function fetchDetail(job) {
  const text = job?.detail?.contentText ?? ''
  if (text) return { ok: true, detail: { ...job.detail, id: job.id, source: 'html' }, warnings: [] }
  return { ok: false, code: 'E_JOB_GONE', detail: null, warnings: [{ code: 'E_JOB_GONE', note: 'govhk 详情没抓到' }] }
}

export const descriptor = Object.freeze({
  id: SOURCE_ID,
  label: SOURCE_LABEL,
  kind: 'browser',
  home: 'https://www.jobs.gov.hk',
  note: '政府职位，搜索 + 详情都在浏览器里完成；无风控，但条数少',
  needsBrowser: true,
})
