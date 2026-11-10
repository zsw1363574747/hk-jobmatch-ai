/**
 * 并发小工具：按固定并发跑一组任务，保持输入顺序无关（worker 自己处理结果）。
 * 之前每个调用点都手写 cursor + workers，容易写成多层循环。
 */
export async function mapLimit(items, limit, worker) {
  const list = Array.isArray(items) ? items : []
  if (list.length === 0) return
  const size = Math.max(1, Math.min(Number(limit) || 1, list.length))
  let cursor = 0
  const run = async () => {
    while (cursor < list.length) {
      const index = cursor
      cursor += 1
      await worker(list[index], index)
    }
  }
  await Promise.all(Array.from({ length: size }, run))
}

/** 按 key 分组成 Map<string, T[]>。 */
export function groupBy(items, keyOf) {
  const groups = new Map()
  for (const item of items) {
    const key = keyOf(item)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }
  return groups
}
