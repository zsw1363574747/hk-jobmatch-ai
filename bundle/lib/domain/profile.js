/** 画像里的年限只有一个口径：0–40 的整数；缺失按 0 处理。 */
export function normalizeYears(value) {
  const years = Number(value)
  if (!Number.isFinite(years) || years < 0) return 0
  return Math.min(40, Math.round(years))
}

export function normalizeProfile(profile) {
  if (!profile || typeof profile !== 'object') return null
  return {
    ...profile,
    years: normalizeYears(profile.years),
    skills: Array.isArray(profile.skills) ? profile.skills : [],
    titles: Array.isArray(profile.titles) ? profile.titles : [],
    domains: Array.isArray(profile.domains) ? profile.domains : [],
  }
}

/** 页面上的“我的经验年限”优先于画像；没有填就用画像。 */
export function resolveProfileYears(profile, override) {
  if (override !== undefined && override !== null && override !== '') {
    const value = Number(override)
    if (Number.isFinite(value) && value >= 0 && value <= 40) return Math.round(value)
  }
  return normalizeYears(profile?.years)
}
