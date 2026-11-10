/**
 * 香港工作地点（值直接取 JobsDB 的 location label 词）。
 *
 * 筛选用的是「子串包含」：选 `Central` 能命中 JobsDB 的
 * `Central, Central and Western District`；选 `Sha Tin District` 能命中
 * `Fo Tan, Sha Tin District`。所以这里存的是地名片段，不是完整 label。
 *
 * 热门放最前（人工按香港招聘量排的），其余按 港岛 / 九龙 / 新界 / 其他 分组。
 * 同一地名只出现一次（热门优先），避免同一个 chip 在两个组里重复。
 */
const item = (value, zh, en) => ({ value, zh, en })

const HOT = [
  item('Central', '中环', 'Central'),
  item('Tsim Sha Tsui', '尖沙咀', 'Tsim Sha Tsui'),
  item('Wan Chai', '湾仔', 'Wan Chai'),
  item('Causeway Bay', '铜锣湾', 'Causeway Bay'),
  item('Kwun Tong', '观塘', 'Kwun Tong'),
  item('Kowloon Bay', '九龙湾', 'Kowloon Bay'),
  item('Sha Tin', '沙田', 'Sha Tin'),
  item('Tsuen Wan', '荃湾', 'Tsuen Wan'),
  item('Lai Chi Kok', '荔枝角', 'Lai Chi Kok'),
  item('Mong Kok', '旺角', 'Mong Kok'),
  item('North Point', '北角', 'North Point'),
  item('Quarry Bay', '鲗鱼涌', 'Quarry Bay'),
]

const HONG_KONG_ISLAND = [
  item('Admiralty', '金钟', 'Admiralty'),
  item('Tai Koo', '太古', 'Tai Koo'),
  item('Chai Wan', '柴湾', 'Chai Wan'),
  item('Aberdeen', '香港仔', 'Aberdeen'),
  item('Wong Chuk Hang', '黄竹坑', 'Wong Chuk Hang'),
  item('Pok Fu Lam', '薄扶林', 'Pok Fu Lam'),
  item('Hong Kong Island', '港岛（泛指）', 'Hong Kong Island'),
  item('Central and Western District', '中西区', 'Central & Western'),
  item('Wan Chai District', '湾仔区', 'Wan Chai District'),
  item('Eastern District', '东区', 'Eastern District'),
  item('Southern District', '南区', 'Southern District'),
]

const KOWLOON = [
  item('Yau Ma Tei', '油麻地', 'Yau Ma Tei'),
  item('Jordan', '佐敦', 'Jordan'),
  item('Hung Hom', '红磡', 'Hung Hom'),
  item('Sham Shui Po', '深水埗', 'Sham Shui Po'),
  item('Cheung Sha Wan', '长沙湾', 'Cheung Sha Wan'),
  item('San Po Kong', '新蒲岗', 'San Po Kong'),
  item('Kai Tak', '启德', 'Kai Tak'),
  item('Wong Tai Sin', '黄大仙', 'Wong Tai Sin'),
  item('Diamond Hill', '钻石山', 'Diamond Hill'),
  item('Yau Tsim Mong District', '油尖旺区', 'Yau Tsim Mong'),
  item('Sham Shui Po District', '深水埗区', 'Sham Shui Po District'),
  item('Kowloon City District', '九龙城区', 'Kowloon City'),
  item('Wong Tai Sin District', '黄大仙区', 'Wong Tai Sin District'),
  item('Kwun Tong District', '观塘区', 'Kwun Tong District'),
]

const NEW_TERRITORIES = [
  item('Fo Tan', '火炭', 'Fo Tan'),
  item('Ma On Shan', '马鞍山', 'Ma On Shan'),
  item('Tai Po', '大埔', 'Tai Po'),
  item('Fanling', '粉岭', 'Fanling'),
  item('Sheung Shui', '上水', 'Sheung Shui'),
  item('Kwai Chung', '葵涌', 'Kwai Chung'),
  item('Kwai Hing', '葵兴', 'Kwai Hing'),
  item('Tsing Yi', '青衣', 'Tsing Yi'),
  item('Tuen Mun', '屯门', 'Tuen Mun'),
  item('Yuen Long', '元朗', 'Yuen Long'),
  item('Tin Shui Wai', '天水围', 'Tin Shui Wai'),
  item('Tseung Kwan O', '将军澳', 'Tseung Kwan O'),
  item('Sai Kung', '西贡', 'Sai Kung'),
  item('New Territories', '新界（泛指）', 'New Territories'),
  item('Kwai Tsing District', '葵青区', 'Kwai Tsing'),
  item('Tsuen Wan District', '荃湾区', 'Tsuen Wan District'),
  item('Tuen Mun District', '屯门区', 'Tuen Mun District'),
  item('Yuen Long District', '元朗区', 'Yuen Long District'),
  item('North District', '北区', 'North District'),
  item('Tai Po District', '大埔区', 'Tai Po District'),
  item('Sha Tin District', '沙田区', 'Sha Tin District'),
  item('Sai Kung District', '西贡区', 'Sai Kung District'),
]

const OTHERS = [item('Islands District', '离岛区', 'Islands District')]

const RAW_GROUPS = [
  { id: 'hot', label: '热门', items: HOT },
  { id: 'hki', label: '香港岛', items: HONG_KONG_ISLAND },
  { id: 'kln', label: '九龙', items: KOWLOON },
  { id: 'nte', label: '新界', items: NEW_TERRITORIES },
  { id: 'other', label: '其他', items: OTHERS },
]

/** 全局去重：热门里出现过的地名，后面组里不再重复。 */
function buildGroups() {
  const seen = new Set()
  return RAW_GROUPS.map((group) => {
    const items = group.items.filter((entry) => {
      if (seen.has(entry.value)) return false
      seen.add(entry.value)
      return true
    })
    return { id: group.id, label: group.label, items }
  }).filter((group) => group.items.length > 0)
}

export const LOCATION_GROUPS = buildGroups()

/** 返回副本，调用方随便改不会污染模块常量。 */
export function locationGroups() {
  return LOCATION_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    items: group.items.map((entry) => ({ ...entry })),
  }))
}

/** 全部合法值（用于轻校验；搜索时仍允许传任意字符串）。 */
export const LOCATION_VALUES = new Set(LOCATION_GROUPS.flatMap((group) => group.items.map((entry) => entry.value)))
