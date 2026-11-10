import { locationGroups } from '../../domain/locations.js'

/**
 * 工作地点选项：给前端弹层用。
 * 纯静态数据，不联网；值就是 JobsDB location label 里的地名片段。
 */
export function locations() {
  return {
    ok: true,
    groups: locationGroups(),
    note: '地点值取自 JobsDB 的 location label；不选 = 全港',
  }
}
