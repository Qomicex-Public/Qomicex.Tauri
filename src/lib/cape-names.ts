/** 微软披风 id → 中文名本地化映射（未知 id 回落原名）。 */
const CAPE_NAMES: Record<string, string> = {
  migrator: '迁移者披风',
  mojang_2020: 'Mojang 2020 披风',
  'minecraft.net': 'Minecraft.net 披风',
  mojira: 'Mojira 贡献者披风',
  founders: '创始者披风',
  'founder': '创始者披风',
  'vanilla': 'Minecraft 官方披风',
  'mcc_12': 'MCC 第 12 届披风',
  'mcc_15': 'MCC 第 15 届披风',
  'mcc_17': 'MCC 第 17 届披风',
  'mcc_2023': 'MCC 2023 披风',
  'mcc_2024': 'MCC 2024 披风',
  'mcc_2025': 'MCC 2025 披风',
  'mcc_twitch_2024': 'MCC Twitch Rivals 2024 披风',
  'mcc_celebration_2025': 'MCC 五周年纪念披风',
}

/** MCC Island / 微软披风（API 返回 UUID id，按 alias 名映射）。键同时兼容驼峰 id 与英文原名。 */
const ALIAS_NAMES: Record<string, string> = {
  Migrator: '迁移者披风',
  MapMaker: 'Realms 地图制作者披风',
  'Realms MapMaker': 'Realms 地图制作者披风',
  Moderator: 'Mojira 管理员披风',
  'Mojira Moderator': 'Mojira 管理员披风',
  TranslatorChinese: 'Crowdin 中文翻译者披风',
  'Chinese Translator': 'Crowdin 中文翻译者披风',
  Translator: 'Crowdin 翻译者披风',
  Cobalt: 'Cobalt 披风',
  Vanilla: '原版披风',
  Minecon2011: 'Minecon 2011 参与者披风',
  'MINECON 2011': 'Minecon 2011 参与者披风',
  Minecon2012: 'Minecon 2012 参与者披风',
  'MINECON 2012': 'Minecon 2012 参与者披风',
  Minecon2013: 'Minecon 2013 参与者披风',
  'MINECON 2013': 'Minecon 2013 参与者披风',
  Minecon2015: 'Minecon 2015 参与者披风',
  'MINECON 2015': 'Minecon 2015 参与者披风',
  Minecon2016: 'Minecon 2016 参与者披风',
  'MINECON 2016': 'Minecon 2016 参与者披风',
  CherryBlossom: '樱花披风',
  'Cherry Blossom': '樱花披风',
  FifteenthAnniversary: '15 周年纪念披风',
  '15th Anniversary': '15 周年纪念披风',
  PurpleHeart: '紫色心形披风',
  'Purple Heart': '紫色心形披风',
  Followers: '追随者披风',
  "Follower's": '追随者披风',
  Mcc: 'MCC 15 周年披风',
  'MCC 15th Year': 'MCC 15 周年披风',
  MinecraftExperience: '村民救援披风',
  'Minecraft Experience': '村民救援披风',
  MojangOffice: 'Mojang 办公室披风',
  'Mojang Office': 'Mojang 办公室披风',
  Home: '家园披风',
  Menace: '入侵披风',
  Yearn: '渴望披风',
  Common: '普通披风',
  Pan: '薄煎饼披风',
  Founders: '创始人披风',
  Copper: '铜披风',
  ZombieHorse: '僵尸马披风',
  'Zombie Horse': '僵尸马披风',
  Builder: '建造者披风',
}

function prettifyCape(id: string): string {
  return id
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

export function capeDisplayName(id: string, alias?: string | null, lang: string = 'zh-CN'): string {
  if (lang !== 'zh-CN') {
    if (alias) return alias
    if (id.startsWith('mcc_')) return `MCC (${id.slice(4)})`
    if (id.startsWith('realms_')) return `Realms (${id.slice(7)})`
    return prettifyCape(id)
  }
  if (CAPE_NAMES[id]) return CAPE_NAMES[id]
  if (id.startsWith('mcc_')) return `MCC 披风 (${id.slice(4)})`
  if (id.startsWith('realms_')) return `Realms 披风 (${id.slice(7)})`
  if (alias && ALIAS_NAMES[alias]) return ALIAS_NAMES[alias]
  if (alias) return alias
  return id
}
