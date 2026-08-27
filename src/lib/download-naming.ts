/**
 * 下载资源文件命名格式（ENH-10）。
 * 模板占位符：{cn} = 中文名，{name} = 英文名，{version} = 版本号。
 */

/** 全部命名格式选项（按语言过滤）。 */
export const FILE_NAMING_OPTIONS = [
  { key: '[{cn}]{name}-{version}', label: 'naming.cnNameVer' },
  { key: '[{name}]{cn}-{version}', label: 'naming.nameCnVer' },
  { key: '{cn}-{name}-{version}', label: 'naming.cnNamePlainVer' },
  { key: '{cn}-{version}', label: 'naming.cnVer' },
  { key: '{name}-{version}', label: 'naming.nameVer' },
  { key: '{cn}', label: 'naming.cn' },
  { key: '{name}', label: 'naming.name' },
] as const

/** 中文环境显示的选项索引（全部 7 项）；非中文环境显示 [name-ver, name] 即索引 4,6。 */
export const FILE_NAMING_ZH = 'zh'
/** 非中文环境默认选项 */
export const FILE_NAMING_DEFAULT = '{name}-{version}'
/** 中文环境默认选项 */
export const FILE_NAMING_ZH_DEFAULT = '[{cn}]{name}-{version}'

/** 过滤文件名中的特殊字符（\/:*?"<>|）。 */
function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '')
}

/** 按命名模板生成文件名。 */
export function formatDownloadFileName(
  template: string,
  info: { name: string; version?: string; cnName?: string | null },
): string {
  let tpl = template
  // 无中文名：移除 [中文名] 括号片段与独立 {cn} 占位符，避免英文名重复
  if (!info.cnName) {
    tpl = tpl.replace(/\[\{cn\}\]/g, '').replace(/\{cn\}/g, '')
  }
  let name = tpl
    .replace(/\{cn\}/g, info.cnName || info.name)
    .replace(/\{name\}/g, info.name)
    .replace(/\{version\}/g, info.version || '')
    // 去掉空占位符残留
    .replace(/\s*\{\w+\}\s*/g, '')
    .replace(/[\[\]]/g, '')
    // 连续多个空格/连字符/下划线 → 单一连字符
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .trim()
  if (!name) name = info.name
  return sanitizeFileName(name)
}

/** 检查文件名是否会在目标目录冲突（同名添加序号后缀）。 */
export function dedupFileName(fileName: string, existingNames: Set<string>): string {
  if (!existingNames.has(fileName)) return fileName
  const dot = fileName.lastIndexOf('.')
  const base = dot > 0 ? fileName.slice(0, dot) : fileName
  const ext = dot > 0 ? fileName.slice(dot) : ''
  for (let i = 1; i < 100; i++) {
    const candidate = `${base}(${i})${ext}`
    if (!existingNames.has(candidate)) return candidate
  }
  return fileName
}