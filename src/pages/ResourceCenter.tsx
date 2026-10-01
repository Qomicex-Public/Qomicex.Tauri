import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useI18n } from '../i18n/index.tsx'
import { ChevronDown, Download, ExternalLink, Folder, FolderPlus, Heart, Pencil, RotateCw, Search, Tag, Trash2, User, X } from 'lucide-react'
import { RotateCw as RotateCwData } from 'lucide'
import { MorphActionIcon } from '../components/MorphActionIcon.tsx'
import { Input } from '../components/ui'
import { PageHeader } from '../components/PageHeader.tsx'
import { PageShell } from '../components/PageShell.tsx'
import { Button } from '../components/ui'
import { Card } from '../components/ui'
import { Badge } from '../components/ui'
import { Select, SelectOption } from '../components/ui'
import { Combobox } from '../components/ui'
import { cn } from '../components/ui'
import { searchResources, getResourceCategories, toResourceItem, type ResourceCategory } from '../api/resource.ts'
import { batchLookupChineseNames } from '../api/mcmod.ts'
import type { ResourceItem, ResourceFavorite } from '../types/index.ts'
import { translateCategory } from '../lib/categoryTranslations.ts'
import ResourceInstallDialog from '../components/ResourceInstallDialog.tsx'
import ModpackQuickInstallDialog from '../components/ModpackQuickInstallDialog.tsx'
import { Tabs } from '../components/ui'
import { Popover } from '../components/ui'
import { Tooltip } from '../components/ui'
import { useMessageBox } from '../components/ui'
import { useAnimatedList } from '../hooks/useGsapAnimations.ts'
import { useFavoritesStore, useFavoriteKeys, useFolderMap, favoriteKey } from '../stores/favoritesStore.ts'
import FavoriteEditDialog from '../components/FavoriteEditDialog.tsx'

interface PageCache {
  items: ResourceItem[]
  total: number
  timestamp: number
}
const searchCache = new Map<string, Map<number, PageCache>>()
const CACHE_TTL = 5 * 60 * 1000

interface Snapshot {
  category: string
  source: string
  keyword: string
  sort: string
  gameVersion: string
  loader: string
  tags: string[]
  items: ResourceItem[]
  total: number
  page: number
  searchInput: string
  cnNames: Record<string, string | null>
  scrollY: number
  /** 资源中心视图：搜索结果 / 收藏（#132）。 */
  view: ResourceView
  /** 收藏视图的收藏夹过滤（#132 P2）：`all` / `unfiled` / 夹子 id。 */
  favFolder: string
  /** 收藏视图的标签过滤（#132 P2，多选 AND）。 */
  favTags: string[]
}
let savedSnapshot: Snapshot | null = null

/** 资源中心的两个视图：搜索（默认）与收藏。 */
type ResourceView = 'search' | 'favorites'

/** 收藏夹过滤里「未分组」的哨兵值（与具体夹子 id 区分开）。 */
const UNFILED = '__unfiled__'

function cacheKey(category: string, keyword: string, sort: string, source: string, gameVersion: string, loader: string, tags: string[]): string {
  return `${source}|${category}|${keyword}|${sort}|${gameVersion}|${loader}|${tags.join(',')}`
}

const CATEGORIES = [
  { key: 'mod' },
  { key: 'modpack' },
  { key: 'shader' },
  { key: 'resourcepack' },
  { key: 'datapack' },
  { key: 'save' },
]

const SOURCES = [
  { key: 'all', label: '全部' },
  { key: 'modrinth', label: 'Modrinth' },
  { key: 'curseforge', label: 'CurseForge' },
  { key: 'ftb', label: 'FTB' },
]

const GAME_VERSIONS = ['26.2', '26.1.2', '26.1.1', '26.1', '1.21.11', '1.21.10', '1.21.9', '1.21.8', '1.21.7', '1.21.6', '1.21.5', '1.21.4', '1.21.3', '1.21.2', '1.21.1', '1.21', '1.20.6', '1.20.5', '1.20.4', '1.20.3', '1.20.2', '1.20.1', '1.20', '1.19.4', '1.19.3', '1.19.2', '1.19.1', '1.19', '1.18.2', '1.18.1', '1.18', '1.17.1', '1.17', '1.16.5', '1.16.4', '1.16.3', '1.16.2', '1.16.1', '1.16']

const LOADERS = [
  { key: 'forge', label: 'Forge' },
  { key: 'fabric', label: 'Fabric' },
  { key: 'neoforge', label: 'NeoForge' },
  { key: 'quilt', label: 'Quilt' },
  { key: 'liteloader', label: 'LiteLoader' },
]

const SORT_OPTIONS: Record<string, { key: string }[]> = {
  all: [
    { key: 'downloads' },
  ],
  modrinth: [
    { key: 'relevance' },
    { key: 'downloads' },
    { key: 'updated' },
    { key: 'newest' },
  ],
  curseforge: [
    { key: 'downloads' },
    { key: 'updated' },
    { key: 'name' },
    { key: 'newest' },
  ],
  ftb: [
    { key: 'relevance' },
    { key: 'downloads' },
    { key: 'updated' },
    { key: 'name' },
    { key: 'newest' },
  ],
}

// 两套独立的标签体系：Modrinth 与 CurseForge 的 category 词汇完全不同。
// 前端按来源展示对应的一套；后端各自解析（Modrinth 直接用 slug，CurseForge
// 把 slug 映射到其数字 categoryId）。

// 类别标签折叠时的高度（单行），超出即出现展开/收起按钮（按实际高度自适应）。
const TAG_COLLAPSED_PX = 28

// Modrinth 模组分类 slug（直接作为 categories facet）。
const MOD_TAGS = [
  'library', 'optimization', 'utility', 'adventure', 'magic', 'technology',
  'food', 'storage', 'worldgen', 'decoration', 'equipment', 'social',
  'support', 'cursed', 'combat', 'mobs', 'management', 'transportation',
  'economy', 'challenging', 'game-mechanics', 'minigame', 'quests',
]

// CurseForge 模组分类 slug（classId=6），与后端 cf_resolve_category_ids 解析的
// CF 实际 category slug 对齐，确保筛选能命中。
const CF_TAGS = [
  'addons', 'armor', 'bibliotheques', 'biomes', 'build-supports', 'config',
  'cosmetic', 'cursed', 'dimensions', 'education', 'farming', 'food',
  'game-mechanics', 'library', 'magic', 'map-and-information', 'mobs',
  'multiplayer', 'ore', 'player-transport', 'redstone', 'science', 'storage',
  'structures', 'technology', 'tools', 'utilities', 'world-generation',
  'adventure',
]

// `all` 聚合搜索会同时向 Modrinth 和 CurseForge 发同一批标签，但 CurseForge 的
// 分类词汇与 Modrinth 不同，无法表示的标签会被后端静默丢弃，导致聚合结果只有一半
// 被过滤。因此 `all` 只暴露两套体系的交集标签，保证两边都按同一筛选条件过滤。
const ALL_TAGS = MOD_TAGS.filter((t) => CF_TAGS.includes(t))

// 根据来源+资源类型返回对应的静态标签集合（动态类别加载失败时的兜底；非 mod 无静态列表）。
function tagsForSource(source: string, category: string): string[] {
  if (category !== 'mod') return []
  if (source === 'curseforge') return CF_TAGS
  if (source === 'all') return ALL_TAGS
  return MOD_TAGS
}

// 把标签列表过滤为当前来源+类型支持的那一套，避免 URL / 快照恢复时标签与来源不匹配。
function normalizeTags(tags: string[], source: string, category: string): string[] {
  const allowed = new Set(tagsForSource(source, category))
  return tags.filter((t) => allowed.has(t))
}

function formatDownloads(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function getSourceLabel(source: string): string {
  const map: Record<string, string> = { modrinth: 'Modrinth', curseforge: 'CurseForge', ftb: 'FTB' }
  return map[source] ?? source
}

// 标签/类别筛选对哪些资源类型生效（ENH-04：全类型类别筛选）。
// - save：无类别体系
// - ftb：用自身分类（暂不扩展）
// - curseforge：仅 mod/modpack 有 classId 分类
// - 其余（modrinth / all 聚合）：mod/modpack/shader/resourcepack/datapack 均支持
function tagsSupported(source: string, category: string): boolean {
  if (category === 'save') return false
  if (source === 'ftb') return false
  if (source === 'curseforge') return category === 'mod' || category === 'modpack'
  return category === 'mod' || category === 'modpack' || category === 'shader' || category === 'resourcepack' || category === 'datapack'
}

/** 类别筛选的静态回退（仅 mod 有内置列表；后端动态类别失败时兜底）。 */
function staticTagsFor(source: string, category: string): string[] {
  if (category !== 'mod') return []
  if (source === 'curseforge') return CF_TAGS
  if (source === 'all') return ALL_TAGS
  return MOD_TAGS
}

function buildDetailUrl(item: ResourceItem, category: string, keyword: string, sort: string, gameVersion?: string, loader?: string, instanceId?: string, tags?: string[]): string {
  const params = new URLSearchParams()
  params.set('source', item.source)
  params.set('category', category)
  params.set('sort', sort)
  if (keyword) params.set('keyword', keyword)
  if (gameVersion) params.set('gameVersion', gameVersion)
  if (loader) params.set('loader', loader)
  if (tags && tags.length > 0) params.set('tags', tags.join(','))
  if (instanceId) params.set('instanceId', instanceId)
  return `/resource-center/${encodeURIComponent(item.id)}?${params.toString()}`
}

/**
 * 解析一批资源的中文名。先用资源标题做 mcmod 精确匹配；标题未命中（如
 * CurseForge 常带括号后缀 "Just Enough Items (JEI)"）时退回用 slug 匹配，
 * 结果统一按 title 归并后给卡片展示。
 */
async function loadCnNames(items: ResourceItem[]): Promise<Record<string, string | null>> {
  const byTitle = await batchLookupChineseNames(items.map(i => i.title))
  const missed = items.filter(i => !byTitle[i.title] && i.slug && i.slug.trim())
  let bySlug: Record<string, string | null> = {}
  if (missed.length > 0) {
    bySlug = await batchLookupChineseNames(missed.map(i => i.slug))
  }
  const out: Record<string, string | null> = {}
  for (const item of items) {
    out[item.title] = byTitle[item.title] ?? bySlug[item.slug] ?? null
  }
  return out
}

function ResourceCard({
  item, category, keyword, sort, gameVersion, loader, instanceId, tags, onInstall, cnName,
  isFavorite, onToggleFavorite, favoriteBusy, folderName, note, itemTags, onEdit,
}: {
  item: ResourceItem
  category: string
  keyword: string
  sort: string
  gameVersion?: string
  loader?: string
  instanceId?: string
  tags?: string[]
  onInstall: (item: ResourceItem) => void
  cnName?: string | null
  isFavorite: boolean
  onToggleFavorite: () => void
  favoriteBusy: boolean
  /** P2：以下四项只在对「已收藏条目」渲染时传入（搜索视图不传）。 */
  folderName?: string
  note?: string | null
  itemTags?: string[]
  onEdit?: () => void
}) {
  const { t, lang } = useI18n()
  return (
    <Card className="group overflow-hidden border-border/60 bg-card/95 transition-all hover:border-primary/20 hover:shadow-lg hover:shadow-primary/5">
      <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start">
        <div className="flex min-w-0 flex-1 gap-4">
          {item.iconUrl ? (
            <img src={item.iconUrl} alt={item.title} className="h-16 w-16 flex-shrink-0 rounded-2xl object-cover ring-1 ring-border/40" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
          ) : (
            <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
              <Tag className="h-5 w-5 opacity-50" />
            </div>
          )}
          <div className="min-w-0 flex-1 space-y-3">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-base font-semibold text-foreground">{lang.startsWith('zh') && cnName ? <>{cnName}<span className="ml-1.5 text-xs font-normal text-muted-foreground/60">| {item.title}</span></> : item.title}</h3>
                <Badge variant="secondary" className="rounded-full px-2.5 py-0.5">{getSourceLabel(item.source)}</Badge>
                {item.latestVersion && <Badge variant="outline" className="rounded-full px-2.5 py-0.5">{item.latestVersion}</Badge>}
              </div>
              <p className="line-clamp-2 text-sm leading-6 text-muted-foreground">{item.description}</p>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <User className="h-3 w-3" />
                {item.author || t('resource.unknownAuthor')}
              </span>
              <span className="inline-flex items-center gap-1">
                <Download className="h-3 w-3" />
                {formatDownloads(item.downloadCount)}
              </span>
            </div>
            {item.categories.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {item.categories.slice(0, 6).map((tag) => (
                  <Badge key={tag} variant="outline" className="rounded-full px-2.5 py-0.5 text-[11px] font-medium">{translateCategory(tag, item.source, lang)}</Badge>
                ))}
              </div>
            )}
            {/* P2：收藏夹 / 自定义标签 / 备注（只在对已收藏条目渲染时出现） */}
            {(folderName || note || (itemTags?.length ?? 0) > 0) && (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {folderName && (
                  <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                    <Folder className="h-3 w-3" />
                    {folderName}
                  </span>
                )}
                {(itemTags ?? []).map((tag) => (
                  <Badge key={tag} variant="secondary" className="rounded-full px-2 py-0.5 text-[11px] font-medium">{tag}</Badge>
                ))}
                {note && (
                  <Tooltip content={note}>
                    <span className="max-w-full truncate rounded-md bg-muted/60 px-2 py-0.5 text-[11px] text-muted-foreground">
                      {t('resource.favorites.note.label')}：{note}
                    </span>
                  </Tooltip>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-row gap-2 sm:min-w-[148px] sm:flex-col sm:items-stretch sm:self-stretch">
          <Button className="flex-1 sm:w-full" onClick={() => onInstall(item)}>
            <Download className="h-3 w-3" />
            {t('resource.install')}
          </Button>
          <Button asChild variant="outline" className="flex-1 sm:w-full">
            <Link to={buildDetailUrl(item, category, keyword, sort, gameVersion, loader, instanceId, tags) + '&expandBody=1'} state={{ iconUrl: item.iconUrl }}>{t('resource.viewDetail')}</Link>
          </Button>
          {/* 底行：原站 / 编辑 / 收藏 —— 三个等宽图标按钮并排，样式统一（都用 outline +
              Tooltip）。不再各占一整行，避免动作列被拉高。 */}
          <div className="flex flex-row gap-2 sm:w-full">
            {item.projectUrl && (
              <div className="flex-1">
                <Tooltip content={t('resource.originalSite')}>
                  <Button asChild variant="outline" className="w-full px-2">
                    <a
                      href={item.projectUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={t('resource.originalSite')}
                    >
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </Button>
                </Tooltip>
              </div>
            )}
            {onEdit && (
              <div className="flex-1">
                <Tooltip content={t('resource.favorites.edit.open')}>
                  <Button
                    variant="outline"
                    className="w-full px-2"
                    aria-label={t('resource.favorites.edit.open')}
                    onClick={onEdit}
                  >
                    <Pencil className="h-3 w-3" />
                  </Button>
                </Tooltip>
              </div>
            )}
            <div className="flex-1">
              <Tooltip content={t(isFavorite ? 'resource.favorites.remove' : 'resource.favorites.add')}>
                <Button
                  variant={isFavorite ? 'secondary' : 'outline'}
                  className="w-full px-2"
                  aria-label={t(isFavorite ? 'resource.favorites.remove' : 'resource.favorites.add')}
                  aria-pressed={isFavorite}
                  disabled={favoriteBusy}
                  onClick={onToggleFavorite}
                >
                  <Heart className={cn('h-3 w-3', isFavorite && 'fill-current text-primary')} />
                </Button>
              </Tooltip>
            </div>
          </div>
        </div>
      </div>
    </Card>
  )
}

export default function ResourceCenter() {
  const { t, lang } = useI18n()
  const { notify, prompt, choose } = useMessageBox()
  const [searchParams, setSearchParams] = useSearchParams()
  const snap = savedSnapshot
  const urlCategory = searchParams.get('category')
  const urlSource = searchParams.get('source')
  const urlKeyword = searchParams.get('keyword')
  const urlSort = searchParams.get('sort')
  const urlGameVersion = searchParams.get('gameVersion')
  const urlLoader = searchParams.get('loader')
  const urlTags = searchParams.get('tags')
  // 快照仅用于"返回"场景（URL 筛选与快照一致）；带新筛选的跳转（如实例内
  // "安装"按钮）视为全新进入，URL 参数优先，不恢复快照。
  const urlState: [keyof Snapshot, string | string[] | null][] = [
    ['category', urlCategory], ['source', urlSource], ['keyword', urlKeyword],
    ['sort', urlSort], ['gameVersion', urlGameVersion], ['loader', urlLoader],
    ['tags', urlTags === null ? null : urlTags.split(',').map((t) => t.trim()).filter(Boolean)],
  ]
  const freshEntry = snap !== null && urlState.some(([k, v]) => v !== null && JSON.stringify(v) !== JSON.stringify(snap[k]))
  const categoryInit = urlCategory ?? (!freshEntry ? snap?.category : undefined) ?? 'mod'
  const [category, setCategory] = useState(categoryInit)
  const [source, setSource] = useState(() => {
    const src = urlSource ?? (!freshEntry ? snap?.source : undefined) ?? 'modrinth'
    return categoryInit === 'save' ? 'curseforge' : src
  })
  const [keyword, setKeyword] = useState(() => urlKeyword ?? (!freshEntry ? snap?.keyword : undefined) ?? '')
  const [searchInput, setSearchInput] = useState(() => urlKeyword ?? (!freshEntry ? snap?.searchInput : undefined) ?? '')
  const [sort, setSort] = useState(() => urlSort ?? (!freshEntry ? snap?.sort : undefined) ?? 'relevance')
  const [gameVersion, setGameVersion] = useState(() => urlGameVersion ?? (!freshEntry ? snap?.gameVersion : undefined) ?? '')
  const [loader, setLoader] = useState(() => (urlLoader ?? (!freshEntry ? snap?.loader : undefined) ?? '').toLowerCase())
  const [tags, setTags] = useState<string[]>(() => {
    const raw = urlTags ? urlTags.split(',').map((t) => t.trim()).filter(Boolean)
      : (!freshEntry && snap?.tags ? snap.tags : [])
    return tagsSupported(categoryInit, source) ? normalizeTags(raw, source, categoryInit) : []
  })
  const instanceId = searchParams.get('instanceId') ?? ''
  // 视图不参与 freshEntry 判定：从详情页带 `?view=favorites` 返回时，筛选未变，
  // 应恢复快照（含 items 与 view），从实例内带新筛选跳进来才视为全新进入。
  const urlView = searchParams.get('view')
  const [view, setView] = useState<ResourceView>(() =>
    urlView === 'favorites' || urlView === 'search'
      ? urlView
      : (!freshEntry && snap?.view === 'favorites' ? 'favorites' : 'search'),
  )
  const [items, setItems] = useState<ResourceItem[]>(() => freshEntry ? [] : (snap?.items ?? []))
  const [total, setTotal] = useState(() => freshEntry ? 0 : (snap?.total ?? 0))
  const [page, setPage] = useState(() => freshEntry ? 1 : (snap?.page ?? 1))
  const [loading, setLoading] = useState(false)
  const [initialLoading, setInitialLoading] = useState(() => !snap || freshEntry)
  const [isReplacing, setIsReplacing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [installDialogItem, setInstallDialogItem] = useState<ResourceItem | null>(null)
  const [modpackInstallItem, setModpackInstallItem] = useState<ResourceItem | null>(null)
  const [cnNames, setCnNames] = useState<Record<string, string | null>>(() => freshEntry ? {} : (snap?.cnNames ?? {}))
  const pageSize = 20

  // ---- 收藏（#132 P1）----
  const favorites = useFavoritesStore((s) => s.favorites)
  const favoritesLoaded = useFavoritesStore((s) => s.loaded)
  const favoritesLoading = useFavoritesStore((s) => s.loading)
  const favoritesError = useFavoritesStore((s) => s.error)
  const loadFavorites = useFavoritesStore((s) => s.load)
  const toggleFavorite = useFavoritesStore((s) => s.toggleFavorite)
  const favoriteKeys = useFavoriteKeys()
  // 正在切换的键集合（防同键连点）。用 Set 而非单值：单值时请求 A 完成会把状态
  // 置空，从而提前解除并发请求 B 的忙碌态。
  const [favBusyKeys, setFavBusyKeys] = useState<Set<string>>(() => new Set())

  // ---- 收藏夹 / 标签（#132 P2）----
  const folders = useFavoritesStore((s) => s.folders)
  const foldersLoaded = useFavoritesStore((s) => s.foldersLoaded)
  const loadFolders = useFavoritesStore((s) => s.loadFolders)
  const createFolder = useFavoritesStore((s) => s.createFolder)
  const renameFolder = useFavoritesStore((s) => s.renameFolder)
  const deleteFolder = useFavoritesStore((s) => s.deleteFolder)
  const folderMap = useFolderMap()
  /** 收藏视图的收藏夹过滤：`all`（全部）/ `unfiled`（未分组）/ 具体夹子 id。 */
  const [favFolder, setFavFolder] = useState<string>(() => (!freshEntry ? snap?.favFolder : undefined) ?? 'all')
  /** 收藏视图的标签过滤（多选，AND）。 */
  const [favTags, setFavTags] = useState<string[]>(() => (!freshEntry ? snap?.favTags : undefined) ?? [])
  /** 正在编辑的收藏（弹窗目标）。 */
  const [editFavorite, setEditFavorite] = useState<ResourceFavorite | null>(null)
  /** 收藏夹下拉是否展开（Popover 受控，选完/新建完要收起）。 */
  const [favFolderMenuOpen, setFavFolderMenuOpen] = useState(false)
  /** 收藏视图的本地搜索（标题 / 作者 / 标签，纯前端过滤，不发请求）。 */
  const [favQuery, setFavQuery] = useState('')

  useEffect(() => { void loadFavorites() }, [loadFavorites])
  // 收藏夹列表只在收藏视图需要（搜索视图不产生额外请求）。
  useEffect(() => {
    if (view !== 'favorites') return
    void loadFolders()
  }, [view, loadFolders])

  // 动态类别列表（按 source+category 拉取；失败时回退静态列表 staticTagsFor）
  const [categoryOptions, setCategoryOptions] = useState<ResourceCategory[] | null>(null)
  const [tagsExpanded, setTagsExpanded] = useState(false)
  const [tagsOverflow, setTagsOverflow] = useState(false)
  const [tagsFullHeight, setTagsFullHeight] = useState(TAG_COLLAPSED_PX)
  const tagsRowRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // 类别列表只在搜索视图需要（收藏视图不展示类别筛选，也不应产生任何请求）。
    if (view !== 'search' || !tagsSupported(source, category)) {
      setCategoryOptions(null)
      return
    }
    let cancelled = false
    getResourceCategories(source === 'curseforge' ? 'curseforge' : 'modrinth', category)
      .then((list) => { if (!cancelled) setCategoryOptions(list) })
      .catch(() => { if (!cancelled) setCategoryOptions(null) })
    return () => { cancelled = true }
  }, [source, category, view])

  const restoredRef = useRef(!freshEntry && !!snap)
  const snapRef = useRef({ category, source, keyword, sort, gameVersion, loader, tags, items, total, page, searchInput, cnNames, view, favFolder, favTags })
  const listRef = useAnimatedList<HTMLDivElement>([items.length, category, source, keyword, sort, initialLoading, isReplacing], { y: 12, scale: 0.97, duration: 0.25 })
  useEffect(() => { snapRef.current = { category, source, keyword, sort, gameVersion, loader, tags, items, total, page, searchInput, cnNames, view, favFolder, favTags } })

  useEffect(() => {
    const params = new URLSearchParams()
    params.set('source', source)
    params.set('category', category)
    params.set('sort', sort)
    if (keyword) params.set('keyword', keyword)
    if (gameVersion) params.set('gameVersion', gameVersion)
    if (loader) params.set('loader', loader)
    if (tags.length > 0 && tagsSupported(source, category)) params.set('tags', tags.join(','))
    if (instanceId) params.set('instanceId', instanceId)
    // 只在收藏视图写 view，避免给普通搜索 URL 平白多一个参数。
    if (view === 'favorites') params.set('view', 'favorites')
    setSearchParams(params, { replace: true })
  }, [category, keyword, setSearchParams, sort, source, gameVersion, loader, tags, instanceId, view])

  const doSearch = useCallback(async (pageNum: number, append: boolean) => {
    setLoading(true)
    setError(null)
    const key = cacheKey(category, keyword, sort, source, gameVersion, loader, tags)
    const cached = searchCache.get(key)?.get(pageNum)
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      setItems((prev) => append ? [...prev, ...cached.items] : cached.items)
      setTotal(cached.total)
      setPage(pageNum)
      setLoading(false)
      setInitialLoading(false)
      if (category === 'mod') loadCnNames(cached.items).then(setCnNames)
      else setCnNames({})
      return
    }
    if (!append) setIsReplacing(true)
    try {
      const res = await searchResources({
        category,
        keyword: keyword || undefined,
        page: pageNum,
        pageSize,
        sort,
        source,
        gameVersion: gameVersion || undefined,
        loader: (loader || '').toLowerCase() || undefined,
        tags: tags.length > 0 ? tags.join(',') : undefined,
      })
      const pageItems = res.items
      if (!searchCache.has(key)) searchCache.set(key, new Map())
      searchCache.get(key)!.set(pageNum, { items: pageItems, total: res.total, timestamp: Date.now() })
      setItems((prev) => append ? [...prev, ...pageItems] : pageItems)
      setTotal(res.total)
      setPage(pageNum)
      if (category === 'mod') loadCnNames(pageItems).then(setCnNames)
      else setCnNames({})
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('resource.searchFailed')
      if (msg.includes('404') || msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
        setError(t('resource.backendUnreachable'))
      } else {
        setError(msg)
      }
      if (!append) setItems([])
    }
    setLoading(false)
    setInitialLoading(false)
    setIsReplacing(false)
  }, [category, keyword, sort, source, gameVersion, loader, tags])

  const scrollEl = () => document.querySelector('main')

  useEffect(() => {
    if (restoredRef.current) {
      const sy = savedSnapshot!.scrollY
      savedSnapshot = null
      requestAnimationFrame(() => scrollEl()?.scrollTo(0, sy))
    }
  }, [])

  useEffect(() => {
    // 收藏视图只做本地过滤，不碰搜索接口与 searchCache。
    if (view === 'favorites') { restoredRef.current = false; return }
    if (restoredRef.current) { restoredRef.current = false; return }
    doSearch(1, false)
  }, [doSearch, view])

  useEffect(() => () => {
    savedSnapshot = { ...snapRef.current, scrollY: scrollEl()?.scrollTop ?? 0 }
  }, [])

  // 收藏视图的数据源：本地过滤（来源 / 分类 / 收藏夹 / 标签），不产生任何搜索请求。
  // 收藏项自带资源快照，因此可直接复用 ResourceCard 渲染与安装。
  const favoriteMatchesScope = useCallback(
    (f: ResourceFavorite) =>
      (source === 'all' || f.source === source) && f.category === category,
    [source, category],
  )
  /** 任一收藏夹（含未分组）在「当前来源/分类」下的条数。 */
  const favFolderCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const f of favorites) {
      if (!favoriteMatchesScope(f)) continue
      // folderId 指向不存在的夹子（手工改过 JSON）按「未分组」统计。
      const key = f.folderId && folderMap.has(f.folderId) ? f.folderId : UNFILED
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
  }, [favorites, favoriteMatchesScope, folderMap])

  /** 标签候选：从「当前来源/分类」的收藏里聚合（不受夹子/标签过滤影响，避免选项自己消失）。 */
  const favTagOptions = useMemo(() => {
    const counts = new Map<string, { label: string; count: number }>()
    for (const f of favorites) {
      if (!favoriteMatchesScope(f)) continue
      for (const tag of f.tags ?? []) {
        const k = tag.toLowerCase()
        const hit = counts.get(k)
        if (hit) hit.count += 1
        else counts.set(k, { label: tag, count: 1 })
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  }, [favorites, favoriteMatchesScope])

  const favoriteItems = useMemo(
    () =>
      favorites
        .filter((f) => {
          if (!favoriteMatchesScope(f)) return false
          if (favFolder === UNFILED) {
            if (f.folderId && folderMap.has(f.folderId)) return false
          } else if (favFolder !== 'all' && f.folderId !== favFolder) {
            return false
          }
          if (favTags.length > 0) {
            const own = (f.tags ?? []).map((x) => x.toLowerCase())
            if (!favTags.every((tag) => own.includes(tag.toLowerCase()))) return false
          }
          // 收藏内搜索：标题 / 作者 / 标签，大小写不敏感（纯本地，无网络请求）
          if (favQuery.trim()) {
            const q = favQuery.trim().toLowerCase()
            const haystack = [f.title, f.author, ...(f.tags ?? [])].join('\n').toLowerCase()
            if (!haystack.includes(q)) return false
          }
          return true
        })
        .map(toResourceItem),
    [favorites, favoriteMatchesScope, favFolder, folderMap, favTags, favQuery],
  )

  /** 左侧收藏夹栏的条目（全部 / 未分组 / 各夹子 + 计数）。 */
  const favRailItems = useMemo(() => {
    const inScope = favorites.filter(favoriteMatchesScope)
    return [
      { key: 'all', label: t('resource.favorites.folders.all'), count: inScope.length },
      { key: UNFILED, label: t('resource.favorites.folders.unfiled'), count: favFolderCounts.get(UNFILED) ?? 0 },
      ...folders.map((f) => ({ key: f.id, label: f.name, count: favFolderCounts.get(f.id) ?? 0 })),
    ]
  }, [favorites, favoriteMatchesScope, favFolderCounts, folders, t])

  // 收藏视图同样补中文名（与搜索一致：仅 mod；走 mcmod 批量查询，不涉及资源搜索）。
  useEffect(() => {
    if (view !== 'favorites' || category !== 'mod' || favoriteItems.length === 0) return
    let cancelled = false
    loadCnNames(favoriteItems)
      .then((names) => { if (!cancelled) setCnNames((prev) => ({ ...prev, ...names })) })
      .catch(() => { /* 中文名是增强项，失败静默 */ })
    return () => { cancelled = true }
  }, [view, category, favoriteItems])

  const handleSearch = () => setKeyword(searchInput.trim())

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch()
  }

  const handleCategoryChange = (nextCategory: string) => {
    if (source === 'ftb' && nextCategory !== 'modpack') return
    if (nextCategory !== 'mod') setTags([])
    if (nextCategory === 'save') {
      if (source !== 'curseforge' && source !== 'all') setSource('curseforge')
      setSort('downloads')
      setCategory(nextCategory)
      return
    }
    setCategory(nextCategory)
  }

  const handleSourceChange = (nextSource: string) => {
    // 切换来源会改变标签体系（Modrinth / CurseForge），跨体系的标签 slug 不通用，
    // 因此来源词汇变化时清空已选标签，避免误把一套标签发给另一套来源。
    if (tagsForSource(nextSource, category) !== tagsForSource(source, category)) setTags([])
    setSource(nextSource)
    if (nextSource === 'ftb') {
      setCategory('modpack')
      setSort('relevance')
      return
    }
    if (nextSource === 'all') {
      setSort('downloads')
      return
    }
    if (category === 'save' && nextSource !== 'curseforge') setCategory('mod')
    setSort(nextSource === 'curseforge' ? 'downloads' : 'relevance')
  }

  const toggleTag = (tag: string) => {
    setTags((prev) => prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag])
  }

  const handleInstall = (item: ResourceItem) => {
    if (category === 'modpack') {
      setModpackInstallItem(item)
    } else {
      setInstallDialogItem(item)
    }
  }

  /** 收藏/取消收藏；失败时 store 已回滚，这里只负责提示。 */
  const handleToggleFavorite = async (item: ResourceItem) => {
    const key = favoriteKey(item.source, item.id, category)
    if (favBusyKeys.has(key)) return
    setFavBusyKeys((prev) => new Set(prev).add(key))
    try {
      const nowFavorite = await toggleFavorite(item, category)
      notify(t(nowFavorite ? 'resource.favorites.added' : 'resource.favorites.removed'), 'success')
    } catch (e) {
      notify(e instanceof Error ? e.message : t('resource.favorites.failed'), 'error')
    } finally {
      setFavBusyKeys((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  const loadMore = () => {
    if (!loading && items.length < total) doSearch(page + 1, true)
  }

  // ---- P2：收藏夹增删改 + 标签过滤 ----

  /** 新建收藏夹：用 MessageBox 的 prompt 取名；重名/空名由服务端拒绝并提示。 */
  const handleCreateFolder = async () => {
    const name = await prompt(t('resource.favorites.folders.createPlaceholder'), t('resource.favorites.folders.create'))
    if (name === null) return
    if (!name.trim()) {
      notify(t('resource.favorites.folders.emptyName'), 'error')
      return
    }
    try {
      const folder = await createFolder(name)
      // 刻意**不**把过滤切到新夹子：刚建好的夹子必然为空，跳过去只会让用户面对空列表。
      notify(t('resource.favorites.folders.created', { name: folder.name }), 'success')
    } catch (e) {
      notify(e instanceof Error ? e.message : t('resource.favorites.folders.failed'), 'error')
    }
  }

  /** 重命名收藏夹。 */
  const handleRenameFolder = async (id: string, current: string) => {
    const name = await prompt(t('resource.favorites.folders.renamePlaceholder'), t('resource.favorites.folders.rename'), current)
    if (name === null) return
    if (!name.trim()) {
      notify(t('resource.favorites.folders.emptyName'), 'error')
      return
    }
    try {
      await renameFolder(id, name)
      notify(t('resource.favorites.folders.renamed'), 'success')
    } catch (e) {
      notify(e instanceof Error ? e.message : t('resource.favorites.folders.failed'), 'error')
    }
  }

  /**
   * 删除收藏夹 —— 服务端会**连同夹内收藏一起删**，所以确认框必须写清条数且不可撤销。
   */
  const handleDeleteFolder = async (id: string, name: string) => {
    const count = favFolderCounts.get(id) ?? 0
    const ok = await choose(
      count > 0
        ? t('resource.favorites.folders.deleteBodyWithItems', { name, count })
        : t('resource.favorites.folders.deleteBodyEmpty', { name }),
      t('resource.favorites.folders.delete'),
      t('common.cancel'),
      t('resource.favorites.folders.deleteTitle'),
    )
    if (!ok) return
    try {
      const removed = await deleteFolder(id)
      if (favFolder === id) setFavFolder('all')
      notify(t('resource.favorites.folders.deleted', { count: removed }), 'success')
    } catch (e) {
      notify(e instanceof Error ? e.message : t('resource.favorites.folders.failed'), 'error')
    }
  }

  const toggleFavTag = (tag: string) =>
    setFavTags((prev) => (prev.includes(tag) ? prev.filter((x) => x !== tag) : [...prev, tag]))

  /** 打开「编辑收藏」弹窗：需要条目本身（含 folderId/note/tags），故从 store 原始列表取。 */
  const handleEditFavorite = (item: ResourceItem) => {
    const key = favoriteKey(item.source, item.id, category)
    setEditFavorite(favorites.find((f) => favoriteKey(f.source, f.id, f.category) === key) ?? null)
  }

  const clearVersion = () => setGameVersion('')
  const clearLoader = () => setLoader('')

  const currentSortOptions = SORT_OPTIONS[source] ?? SORT_OPTIONS.modrinth
  const allTags = useMemo(
    () => (categoryOptions ? categoryOptions.map((o) => o.slug) : staticTagsFor(source, category)),
    [categoryOptions, source, category],
  )
  // 折叠时把已选标签排到最前，避免被裁掉
  const orderedTags = tagsExpanded
    ? allTags
    : [...allTags.filter((s) => tags.includes(s)), ...allTags.filter((s) => !tags.includes(s))]

  useLayoutEffect(() => { setTagsExpanded(false) }, [allTags])

  useLayoutEffect(() => {
    const el = tagsRowRef.current
    if (!el) return
    const measure = () => {
      const full = el.scrollHeight
      setTagsFullHeight(full)
      setTagsOverflow(full > TAG_COLLAPSED_PX + 1)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [allTags, tags, lang])
  const activeCategoryLabel = useMemo(() => {
    const found = CATEGORIES.find((item) => item.key === category)
    return found ? t(`resource.categories.${found.key}`) : category
  }, [category, t])

  // 两个视图共用同一套渲染分支，这里把数据源/错误/空态收敛成视图相关的派生值。
  const shownItems = view === 'favorites' ? favoriteItems : items
  const shownError = view === 'favorites' ? favoritesError : error
  /** 是否「有收藏但被当前来源/分类过滤掉了」——决定空态文案。 */
  const hasAnyFavorite = favorites.length > 0

  return (
    <PageShell className="p-8 space-y-6 overflow-y-auto scroll-fade-mask">
      <PageHeader title={t('resource.title')} />

      <Card className="border-border/60 bg-muted/20 p-4">
        <div className="space-y-4">
          {/* 顶部工具行（#132 P2 布局）：收藏夹下拉 + 搜索 + 视图切换按钮。
              视图切换只保留**一个**按钮、文案随视图变（搜索视图=绿色「♡ 收藏 (N)」进入收藏；
              收藏视图=「搜索」返回），避免图标组与绿色按钮重复表达同一件事。 */}
          <div className="flex flex-wrap items-center gap-2">
            {view === 'favorites' && (
              <Popover
                open={favFolderMenuOpen}
                onOpenChange={setFavFolderMenuOpen}
                className="min-w-[168px] max-w-[220px]"
                trigger={
                  <button
                    type="button"
                    aria-label={t('resource.favorites.folders.railTitle')}
                    aria-expanded={favFolderMenuOpen}
                    className={cn(
                      'flex h-10 w-full items-center gap-2 rounded-lg border border-border/60 bg-background/60 px-3 text-sm transition-colors',
                      favFolderMenuOpen ? 'border-primary/40 text-foreground' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <Folder className="h-4 w-4 shrink-0 opacity-80" />
                    <span className="min-w-0 flex-1 truncate text-left">
                      {favRailItems.find((r) => r.key === favFolder)?.label ?? t('resource.favorites.folders.all')}
                    </span>
                    <span className="shrink-0 text-[11px] tabular-nums opacity-60">
                      {favRailItems.find((r) => r.key === favFolder)?.count ?? 0}
                    </span>
                    <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 transition-transform', favFolderMenuOpen && 'rotate-180')} />
                  </button>
                }
              >
                <p className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-[0.15em] text-muted-foreground/60">
                  {t('resource.favorites.folders.railTitle')}
                </p>
                <div className="max-h-72 overflow-y-auto">
                  {favRailItems.map((row) => {
                    const active = favFolder === row.key
                    const isRealFolder = row.key !== 'all' && row.key !== UNFILED
                    return (
                      <div
                        key={row.key}
                        className={cn(
                          'group/rail flex items-center gap-1 rounded-md px-2 py-1.5 text-sm transition-colors',
                          active ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => { setFavFolder(row.key); setFavFolderMenuOpen(false) }}
                          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                          aria-pressed={active}
                        >
                          <Folder className={cn('h-3.5 w-3.5 shrink-0', active ? 'opacity-100' : 'opacity-50')} />
                          <span className="truncate">{row.label}</span>
                        </button>
                        <span className="shrink-0 text-[11px] tabular-nums opacity-60">{row.count}</span>
                        {isRealFolder && (
                          <span className="hidden shrink-0 items-center gap-0.5 group-hover/rail:flex">
                            <button
                              type="button"
                              onClick={() => { setFavFolderMenuOpen(false); void handleRenameFolder(row.key, row.label) }}
                              aria-label={t('resource.favorites.folders.rename')}
                              className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                            >
                              <Pencil className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => { setFavFolderMenuOpen(false); void handleDeleteFolder(row.key, row.label) }}
                              aria-label={t('resource.favorites.folders.delete')}
                              className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-destructive"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
                {foldersLoaded === false && (
                  <p className="px-3 pt-1 text-[11px] text-muted-foreground/60">{t('resource.favorites.folders.loading')}</p>
                )}
                <div className="mt-1 border-t border-border/60 pt-1">
                  <button
                    type="button"
                    onClick={() => { setFavFolderMenuOpen(false); void handleCreateFolder() }}
                    className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <FolderPlus className="h-3.5 w-3.5" />
                    {t('resource.favorites.folders.create')}
                  </button>
                </div>
              </Popover>
            )}

            {/* 收藏内搜索：只在收藏视图出现（搜索视图有自己的一整行搜索区，避免两个搜索框）。
                纯本地过滤标题 / 作者 / 标签，不发网络请求。 */}
            {view === 'favorites' && (
              <div className="relative min-w-[200px] flex-1">
                <Input
                  value={favQuery}
                  onChange={(e) => setFavQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                  placeholder={t('resource.searchPlaceholder', { category: t('resource.favorites.viewLabel') })}
                  className="h-10 pl-9"
                />
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              </div>
            )}

            {/* 视图切换：单个按钮，文案随视图变（有可见文字，故不再套 Tooltip） */}
            <button
              type="button"
              onClick={() => setView(view === 'favorites' ? 'search' : 'favorites')}
              aria-label={view === 'favorites'
                ? t('resource.favorites.viewSearch')
                : t('resource.favorites.viewLabel')}
              aria-pressed={view === 'favorites'}
              className={cn(
                'ml-auto flex h-10 items-center gap-2 rounded-lg border px-4 text-sm font-medium transition-colors',
                view === 'favorites'
                  ? 'border-border/60 text-muted-foreground hover:bg-accent hover:text-foreground'
                  : 'border-primary/40 text-primary hover:bg-primary/10',
              )}
            >
              {view === 'favorites'
                ? <><Search className="h-4 w-4" />{t('resource.favorites.viewSearch')}</>
                : (
                  <>
                    <Heart className="h-4 w-4" />
                    {favorites.length > 0
                      ? t('resource.favorites.viewLabelWithCount', { count: favorites.length })
                      : t('resource.favorites.viewLabel')}
                  </>
                )}
            </button>
          </div>

          <div className="flex flex-wrap items-start gap-4 xl:items-center xl:justify-between">
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground/70">{t('resource.sourceLabel')}</p>
              <Tabs tabs={SOURCES.map(s => ({ id: s.key, label: s.key === 'all' ? t('resource.sources.all') : s.label }))} activeTab={source} onChange={handleSourceChange} />
            </div>
            <div className="space-y-2 xl:ml-auto">
              <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground/70">{t('resource.categoryLabel')}</p>
              <Tabs tabs={CATEGORIES.map(c => ({ id: c.key, label: t(`resource.categories.${c.key}`), disabled: (source === 'ftb' && c.key !== 'modpack') || (source !== 'curseforge' && source !== 'all' && c.key === 'save') }))} activeTab={category} onChange={handleCategoryChange} />
            </div>
          </div>

          {view === 'search' && (
            <>
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_180px_110px]">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
              <Input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} onKeyDown={handleKeyDown} placeholder={t('resource.searchPlaceholder', { category: activeCategoryLabel })} className="h-10 rounded-xl border-border/60 bg-background pl-9" />
            </div>
            <Select value={sort} onChange={setSort} className="h-10">
              {currentSortOptions.map((item) => (
                <SelectOption key={item.key} value={item.key}>{t(`resource.sort.${item.key}`)}</SelectOption>
              ))}
            </Select>
            <Button onClick={handleSearch} className="h-10 rounded-xl">
              <Search className="h-3.5 w-3.5" />
              {t('resource.search')}
            </Button>
          </div>

          <div className="flex flex-wrap items-start gap-4">
            <div className="space-y-1">
              <p className="text-[11px] font-medium text-muted-foreground">{t('resource.gameVersionLabel')}</p>
              <div className="flex items-center gap-1">
                <Combobox value={gameVersion} onChange={setGameVersion} options={GAME_VERSIONS.map((v) => ({ value: v, label: v }))} placeholder={t('resource.allVersions')} emptyText={t('common.noMatch')} className="w-[150px]" />
                {gameVersion && (
                  <button onClick={clearVersion} className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
            <div className="space-y-1">
              <p className="text-[11px] font-medium text-muted-foreground">{t('resource.loaderLabel')}</p>
              <div className="flex items-center gap-1">
                <Select value={loader} onChange={(v) => setLoader(v.toLowerCase())} className="h-9 min-w-[120px]" placeholder={t('resource.allLoaders')}>
                  {LOADERS.map((l) => (
                    <SelectOption key={l.key} value={l.key}>{l.label}</SelectOption>
                  ))}
                </Select>
                {loader && (
                  <button onClick={clearLoader} className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
            {tagsSupported(source, category) && (
              <div className="w-full space-y-1">
                <p className="text-[11px] font-medium text-muted-foreground">
                  {t('resource.categoryFilterLabel')}
                </p>
                <div
                  ref={tagsRowRef}
                  className="flex flex-wrap gap-1.5 overflow-hidden transition-[max-height] duration-300 ease-out"
                  style={{ maxHeight: tagsExpanded ? tagsFullHeight : TAG_COLLAPSED_PX }}
                >
                  {orderedTags.map((slug) => {
                    const active = tags.includes(slug)
                    return (
                      <button
                        key={slug}
                        type="button"
                        onClick={() => toggleTag(slug)}
                        className={cn(
                          'rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
                          active
                            ? 'border-primary/40 bg-primary/10 text-primary'
                            : 'border-border/60 bg-background text-muted-foreground hover:border-primary/30 hover:text-foreground',
                        )}
                      >
                        {translateCategory(slug, source === 'curseforge' ? 'curseforge' : 'modrinth', lang)}
                      </button>
                    )
                  })}
                </div>
                {(tagsOverflow || tags.length > 0) && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {tags.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setTags([])}
                        className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                      >
                        <X className="h-3 w-3" />
                        {t('resource.clearFilter')}
                      </button>
                    )}
                    {tagsOverflow && (
                      <button
                        type="button"
                        onClick={() => setTagsExpanded((v) => !v)}
                        className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                      >
                        <ChevronDown className={cn('h-3 w-3 transition-transform', tagsExpanded && 'rotate-180')} />
                        {t(tagsExpanded ? 'resource.collapseTags' : 'resource.expandTags')}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
            </>
          )}
        </div>
      </Card>

      {/* P2 布局：收藏夹改为顶部下拉后不再需要左栏，列表占满整宽。 */}
      <div className={cn(view === 'favorites' && 'space-y-3')}>
          {view === 'favorites' && (favTagOptions.length > 0 || shownItems.length > 0) && (
            <div className="flex flex-wrap items-center gap-1.5">
              {favTagOptions.length > 0 && (
                <span className="text-[11px] font-medium text-muted-foreground">
                  {t('resource.favorites.tags.filterLabel')}
                </span>
              )}
              {favTagOptions.map(({ label, count }) => {
                const active = favTags.some((x) => x.toLowerCase() === label.toLowerCase())
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={() => toggleFavTag(label)}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
                      active
                        ? 'border-primary/40 bg-primary/10 text-primary'
                        : 'border-border/60 bg-background text-muted-foreground hover:border-primary/30 hover:text-foreground',
                    )}
                  >
                    {label}
                    <span className="tabular-nums opacity-60">{count}</span>
                  </button>
                )
              })}
              {favTags.length > 0 && (
                <button
                  type="button"
                  onClick={() => setFavTags([])}
                  className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                  {t('resource.clearFilter')}
                </button>
              )}
              {/* 计数挪到筛选行右侧（空列表时由空态文案承担，避免重复） */}
              {shownItems.length > 0 && (
                <span className="ml-auto text-xs text-muted-foreground/60">
                  {t('resource.favorites.allShown', { count: shownItems.length })}
                </span>
              )}
            </div>
          )}

      {(view === 'search' ? (initialLoading || isReplacing) : (favoritesLoading && !favoritesLoaded)) ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 5 }).map((_, index) => (
            <Card key={index} className="animate-pulse p-4">
              <div className="flex gap-4">
                <div className="h-16 w-16 rounded-2xl bg-muted" />
                <div className="flex-1 space-y-3">
                  <div className="h-5 w-1/3 rounded bg-muted" />
                  <div className="h-4 w-3/4 rounded bg-muted" />
                  <div className="h-4 w-1/4 rounded bg-muted" />
                </div>
              </div>
            </Card>
          ))}
        </div>
      ) : shownError ? (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-destructive/10">
            <Search className="h-6 w-6 text-destructive/60" />
          </div>
          <p className="text-sm font-medium text-foreground/80">{t(view === 'favorites' ? 'resource.favorites.loadFailed' : 'resource.searchFailed')}</p>
          <p className="mt-1 text-xs text-muted-foreground/60">{shownError}</p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => { if (view === 'favorites') void loadFavorites(true); else doSearch(1, false) }}
            className="mt-4"
          >
            <MorphActionIcon active={view === 'favorites' ? favoritesLoading : loading} busy={RotateCwData} rest={RotateCwData} className="mr-1.5 h-3 w-3" />
            {t('resource.retry')}
          </Button>
        </div>
      ) : shownItems.length === 0 ? (
        view === 'favorites' ? (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted">
              <Heart className="h-6 w-6 opacity-40" />
            </div>
            <p className="text-sm font-medium text-foreground/80">{t(hasAnyFavorite ? 'resource.favorites.filteredEmpty' : 'resource.favorites.emptyTitle')}</p>
            <p className="mt-1 text-xs text-muted-foreground/60">{t(hasAnyFavorite ? 'resource.favorites.filteredEmptyHint' : 'resource.favorites.emptyHint')}</p>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted">
              <Search className="h-6 w-6 opacity-40" />
            </div>
            <p className="text-sm font-medium text-foreground/80">{t('resource.notFound')}</p>
            <p className="mt-1 text-xs text-muted-foreground/60">{t('resource.notFoundHint')}</p>
          </div>
        )
      ) : (
        <>
          <div ref={listRef} className="flex flex-col gap-3">
            {shownItems.map((item) => {
              const itemKey = favoriteKey(item.source, item.id, category)
              // 收藏视图下取出该条目的 P2 元数据（夹子名 / 备注 / 标签）与编辑入口。
              const fav = view === 'favorites'
                ? favorites.find((f) => favoriteKey(f.source, f.id, f.category) === itemKey)
                : undefined
              const folderName = fav?.folderId && folderMap.has(fav.folderId)
                ? folderMap.get(fav.folderId)?.name
                : undefined
              return (
                <div key={`${view}-${item.source}-${item.id}`} data-key={`${item.source}-${item.id}`}>
                  <ResourceCard
                    item={item}
                    category={category}
                    keyword={keyword}
                    sort={sort}
                    gameVersion={gameVersion}
                    loader={loader}
                    instanceId={instanceId}
                    tags={tags}
                    onInstall={handleInstall}
                    cnName={cnNames[item.title]}
                    isFavorite={favoriteKeys.has(itemKey)}
                    favoriteBusy={favBusyKeys.has(itemKey)}
                    onToggleFavorite={() => { void handleToggleFavorite(item) }}
                    folderName={folderName}
                    note={fav?.note ?? null}
                    itemTags={fav?.tags ?? []}
                    onEdit={view === 'favorites' ? () => handleEditFavorite(item) : undefined}
                  />
                </div>
              )
            })}
          </div>

          {view === 'search' && (
            !initialLoading && !isReplacing && !error && items.length > 0 && (
              items.length < total ? (
                <div className="mt-5 flex justify-center">
                  <Button variant="outline" size="sm" onClick={loadMore} disabled={loading} className="min-w-[160px] gap-1.5">
                    {loading ? <><RotateCw className="h-3 w-3 animate-spin" />{t('resource.loading')}</> : <>{t('resource.loadMore', { current: items.length, total })}</>}
                  </Button>
                </div>
              ) : (
                <p className="mt-5 text-center text-xs text-muted-foreground/50">{t('resource.allShown', { count: total })}</p>
              )
            )
          )}
        </>
      )}
      </div>

      {editFavorite && (
        <FavoriteEditDialog
          open={true}
          onClose={() => setEditFavorite(null)}
          favorite={editFavorite}
          category={category}
          onSaved={() => notify(t('resource.favorites.edit.saved'), 'success')}
        />
      )}

      {installDialogItem && (
        <ResourceInstallDialog
          open={true}
          onClose={() => setInstallDialogItem(null)}
          resourceId={installDialogItem.id}
          resourceTitle={installDialogItem.title}
          resourceIcon={installDialogItem.iconUrl}
          source={installDialogItem.source}
          category={category}
          instanceId={instanceId}
          resourceCnName={cnNames[installDialogItem.title] ?? null}
        />
      )}

      {modpackInstallItem && (
        <ModpackQuickInstallDialog
          open={true}
          onClose={() => setModpackInstallItem(null)}
          modpackName={modpackInstallItem.title}
          projectId={modpackInstallItem.id}
          source={modpackInstallItem.source}
          iconUrl={modpackInstallItem.iconUrl}
        />
      )}
    </PageShell>
  )
}
