/**
 * 浏览器来源的站点配置（数据，不是逻辑）。
 *
 * 想加新站：在这里加一条，`id / label / home / searchUrl / linkPattern` 四样给齐，
 * 再去 index.js 把它放进 CATALOG、把 id 加进 ENABLED_SOURCE_IDS。改版了只改这里。
 */
import { createBrowserSource } from './browser-site.js'

export const ctgoodjobs = createBrowserSource({
  id: 'ctgoodjobs',
  label: 'CTgoodjobs',
  home: 'https://jobs.ctgoodjobs.hk',
  note: '香港第二大招聘站；有 AWS WAF 人工验证，需要过一次验证后复用浏览器 profile',
  // 注意：站点的搜索参数是 `q`，不是 `keyword`——用 `keyword` 会被忽略、返回全站随机岗位。
  searchUrl: (keywords) => `https://jobs.ctgoodjobs.hk/jobs?q=${encodeURIComponent(keywords)}`,
  // AWS WAF 的挑战页特征
  blocked: /Human Verification|gokuProps|awsWafCookieDomainList/i,
  blockedNote: 'CTgoodjobs 弹了 AWS WAF「Human Verification」。跑 `node bundle/bin/cli.mjs browser-login ctgoodjobs`，在弹出的窗口里点一下，之后 profile 里会有通行 cookie',
  linkPattern: /\/job\/[^"']+/i,
  emptyNote: '页面过了验证但没解析到岗位卡片；可能是改版，把新的岗位链接特征写进 linkPattern',
  detailWaitFor: null,
})

export const linkedin = createBrowserSource({
  id: 'linkedin',
  label: 'LinkedIn',
  home: 'https://www.linkedin.com',
  note: '风控最严（用户协议禁止 bot）；只读列表、低频，建议用求职小号',
  searchUrl: (keywords) =>
    `https://www.linkedin.com/jobs/search?keywords=${encodeURIComponent(keywords)}&location=Hong%20Kong&f_TPR=r60480&sortBy=DD`,
  blocked: /linkedin\.cn|authwall|checkpoint\/challenge|Sign in to see/i,
  blockedNote: 'LinkedIn 把请求导向了登录/验证页（或重定向到 linkedin.cn）。要用请在 browser-login 里先登录一次，或换一条能直连 LinkedIn 的网络',
  linkPattern: /\/jobs\/view\/\d+/i,
  emptyNote: 'LinkedIn 页面渲染了但没抓到岗位；多半是访客态被折叠，登录后重试',
})

export const indeed = createBrowserSource({
  id: 'indeed',
  label: 'Indeed HK',
  home: 'https://hk.indeed.com',
  note: 'Cloudflare 拦得最死；能出结果时优先用 JSON-LD 解析',
  searchUrl: (keywords) => `https://hk.indeed.com/jobs?q=${encodeURIComponent(keywords)}&l=Hong+Kong`,
  blocked: /Blocked - Indeed|Additional Verification Required|cf-challenge|Just a moment/i,
  blockedNote: 'Indeed 直接返回了拦截页（Blocked / Cloudflare）。这台机器/这条网络基本抓不到，建议用 browser-login 人工过验证，或换网络',
  linkPattern: /\/viewjob\?jk=[a-z0-9]+|\/rc\/clk\?jk=/i,
  emptyNote: 'Indeed 页面没给出岗位卡片；多半仍处于拦截态',
})

export const browserSources = [ctgoodjobs, linkedin, indeed]
