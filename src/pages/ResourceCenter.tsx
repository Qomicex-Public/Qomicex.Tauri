import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useI18n } from '../i18n/index.tsx'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faArrowUpRightFromSquare, faDownload, faMagnifyingGlass, faRotate, faTag, faUser, faXmark } from '@fortawesome/free-solid-svg-icons'
import { Input } from '../components/ui'
import { PageHeader } from '../components/PageHeader.tsx'
import { PageShell } from '../components/PageShell.tsx'
import { Button } from '../components/ui'
import { Card } from '../components/ui'
import { Badge } from '../components/ui'
import { Select, SelectOption } from '../components/ui'
import { Combobox } from '../components/ui'
import { searchResources } from '../api/resource.ts'
import { batchLookupChineseNames } from '../api/mcmod.ts'
import type { ResourceItem } from '../types/index.ts'
import { translateCategory } from '../lib/categoryTranslations.ts'
import ResourceInstallDialog from '../components/ResourceInstallDialog.tsx'
import ModpackQuickInstallDialog from '../components/ModpackQuickInstallDialog.tsx'
import { Tabs } from '../components/ui'

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
  items: ResourceItem[]
  total: number
  page: number
  searchInput: string
  cnNames: Record<string, string | null>
  scrollY: number
}
let savedSnapshot: Snapshot | null = null

function cacheKey(category: string, keyword: string, sort: string, source: string, gameVersion: string, loader: string): string {
  return `${source}|${category}|${keyword}|${sort}|${gameVersion}|${loader}`
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

function formatDownloads(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function getSourceLabel(source: string): string {
  const map: Record<string, string> = { modrinth: 'Modrinth', curseforge: 'CurseForge', ftb: 'FTB' }
  return map[source] ?? source
}

function buildDetailUrl(item: ResourceItem, category: string, keyword: string, sort: string, gameVersion?: string, loader?: string, instanceId?: string): string {
  const params = new URLSearchParams()
  params.set('source', item.source)
  params.set('category', category)
  params.set('sort', sort)
  if (keyword) params.set('keyword', keyword)
  if (gameVersion) params.set('gameVersion', gameVersion)
  if (loader) params.set('loader', loader)
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
  item, category, keyword, sort, gameVersion, loader, instanceId, onInstall, cnName,
}: {
  item: ResourceItem
  category: string
  keyword: string
  sort: string
  gameVersion?: string
  loader?: string
  instanceId?: string
  onInstall: (item: ResourceItem) => void
  cnName?: string | null
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
              <FontAwesomeIcon icon={faTag} className="h-5 w-5 opacity-50" />
            </div>
          )}
          <div className="min-w-0 flex-1 space-y-3">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-base font-semibold text-foreground">{cnName ? <>{cnName}<span className="ml-1.5 text-xs font-normal text-muted-foreground/60">| {item.title}</span></> : item.title}</h3>
                <Badge variant="secondary" className="rounded-full px-2.5 py-0.5">{getSourceLabel(item.source)}</Badge>
                {item.latestVersion && <Badge variant="outline" className="rounded-full px-2.5 py-0.5">{item.latestVersion}</Badge>}
              </div>
              <p className="line-clamp-2 text-sm leading-6 text-muted-foreground">{item.description}</p>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <FontAwesomeIcon icon={faUser} className="h-3 w-3" />
                {item.author || t('resource.unknownAuthor')}
              </span>
              <span className="inline-flex items-center gap-1">
                <FontAwesomeIcon icon={faDownload} className="h-3 w-3" />
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
          </div>
        </div>
        <div className="flex flex-row gap-2 sm:min-w-[148px] sm:flex-col sm:items-stretch sm:self-stretch">
          <Button className="flex-1 sm:w-full" onClick={() => onInstall(item)}>
            <FontAwesomeIcon icon={faDownload} className="h-3 w-3" />
            {t('resource.install')}
          </Button>
          <Button asChild variant="outline" className="flex-1 sm:w-full">
            <Link to={buildDetailUrl(item, category, keyword, sort, gameVersion, loader, instanceId) + '&expandBody=1'} state={{ iconUrl: item.iconUrl }}>{t('resource.viewDetail')}</Link>
          </Button>
          {item.projectUrl && (
            <Button asChild variant="ghost" className="px-3 sm:w-full">
              <a href={item.projectUrl} target="_blank" rel="noopener noreferrer">
                <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="h-3 w-3" />
                {t('resource.originalSite')}
              </a>
            </Button>
          )}
        </div>
      </div>
    </Card>
  )
}

export default function ResourceCenter() {
  const { t } = useI18n()
  const [searchParams, setSearchParams] = useSearchParams()
  const snap = savedSnapshot
  const urlCategory = searchParams.get('category')
  const urlSource = searchParams.get('source')
  const urlKeyword = searchParams.get('keyword')
  const urlSort = searchParams.get('sort')
  const urlGameVersion = searchParams.get('gameVersion')
  const urlLoader = searchParams.get('loader')
  // 快照仅用于"返回"场景（URL 筛选与快照一致）；带新筛选的跳转（如实例内
  // "安装"按钮）视为全新进入，URL 参数优先，不恢复快照。
  const urlState: [keyof Snapshot, string | null][] = [
    ['category', urlCategory], ['source', urlSource], ['keyword', urlKeyword],
    ['sort', urlSort], ['gameVersion', urlGameVersion], ['loader', urlLoader],
  ]
  const freshEntry = snap !== null && urlState.some(([k, v]) => v !== null && v !== snap[k])
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
  const instanceId = searchParams.get('instanceId') ?? ''
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

  const restoredRef = useRef(!freshEntry && !!snap)
  const snapRef = useRef({ category, source, keyword, sort, gameVersion, loader, items, total, page, searchInput, cnNames })
  useEffect(() => { snapRef.current = { category, source, keyword, sort, gameVersion, loader, items, total, page, searchInput, cnNames } })

  useEffect(() => {
    const params = new URLSearchParams()
    params.set('source', source)
    params.set('category', category)
    params.set('sort', sort)
    if (keyword) params.set('keyword', keyword)
    if (gameVersion) params.set('gameVersion', gameVersion)
    if (loader) params.set('loader', loader)
    if (instanceId) params.set('instanceId', instanceId)
    setSearchParams(params, { replace: true })
  }, [category, keyword, setSearchParams, sort, source, gameVersion, loader, instanceId])

  const doSearch = useCallback(async (pageNum: number, append: boolean) => {
    setLoading(true)
    setError(null)
    const key = cacheKey(category, keyword, sort, source, gameVersion, loader)
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
  }, [category, keyword, sort, source, gameVersion, loader])

  const scrollEl = () => document.querySelector('main')

  useEffect(() => {
    if (restoredRef.current) {
      const sy = savedSnapshot!.scrollY
      savedSnapshot = null
      requestAnimationFrame(() => scrollEl()?.scrollTo(0, sy))
    }
  }, [])

  useEffect(() => {
    if (restoredRef.current) { restoredRef.current = false; return }
    doSearch(1, false)
  }, [doSearch])

  useEffect(() => () => {
    savedSnapshot = { ...snapRef.current, scrollY: scrollEl()?.scrollTop ?? 0 }
  }, [])

  const handleSearch = () => setKeyword(searchInput.trim())

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch()
  }

  const handleCategoryChange = (nextCategory: string) => {
    if (source === 'ftb' && nextCategory !== 'modpack') return
    if (nextCategory === 'save') {
      if (source !== 'curseforge' && source !== 'all') setSource('curseforge')
      setSort('downloads')
      setCategory(nextCategory)
      return
    }
    setCategory(nextCategory)
  }

  const handleSourceChange = (nextSource: string) => {
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

  const handleInstall = (item: ResourceItem) => {
    if (category === 'modpack') {
      setModpackInstallItem(item)
    } else {
      setInstallDialogItem(item)
    }
  }

  const loadMore = () => {
    if (!loading && items.length < total) doSearch(page + 1, true)
  }

  const clearVersion = () => setGameVersion('')
  const clearLoader = () => setLoader('')

  const currentSortOptions = SORT_OPTIONS[source] ?? SORT_OPTIONS.modrinth
  const activeCategoryLabel = useMemo(() => {
    const found = CATEGORIES.find((item) => item.key === category)
    return found ? t(`resource.categories.${found.key}`) : category
  }, [category, t])

  return (
    <PageShell className="p-8 space-y-6 overflow-y-auto scroll-fade-mask">
      <PageHeader title={t('resource.title')} />

      <Card className="border-border/60 bg-muted/20 p-4">
        <div className="space-y-4">
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

          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_180px_110px]">
            <div className="relative">
              <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
              <Input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} onKeyDown={handleKeyDown} placeholder={t('resource.searchPlaceholder', { category: activeCategoryLabel })} className="h-10 rounded-xl border-border/60 bg-background pl-9" />
            </div>
            <Select value={sort} onChange={setSort} className="h-10">
              {currentSortOptions.map((item) => (
                <SelectOption key={item.key} value={item.key}>{t(`resource.sort.${item.key}`)}</SelectOption>
              ))}
            </Select>
            <Button onClick={handleSearch} className="h-10 rounded-xl">
              <FontAwesomeIcon icon={faMagnifyingGlass} className="h-3.5 w-3.5" />
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
                    <FontAwesomeIcon icon={faXmark} className="h-4 w-4" />
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
                    <FontAwesomeIcon icon={faXmark} className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </Card>

      {(initialLoading || isReplacing) ? (
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
      ) : error ? (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-destructive/10">
            <FontAwesomeIcon icon={faMagnifyingGlass} className="h-6 w-6 text-destructive/60" />
          </div>
          <p className="text-sm font-medium text-foreground/80">{t('resource.searchFailed')}</p>
          <p className="mt-1 text-xs text-muted-foreground/60">{error}</p>
          <Button size="sm" variant="outline" onClick={() => doSearch(1, false)} className="mt-4">
            <FontAwesomeIcon icon={faRotate} className="mr-1.5 h-3 w-3" />
            {t('resource.retry')}
          </Button>
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted">
            <FontAwesomeIcon icon={faMagnifyingGlass} className="h-6 w-6 opacity-40" />
          </div>
          <p className="text-sm font-medium text-foreground/80">{t('resource.notFound')}</p>
          <p className="mt-1 text-xs text-muted-foreground/60">{t('resource.notFoundHint')}</p>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-3">
            {items.map((item) => (
              <ResourceCard key={`${item.source}-${item.id}`} item={item} category={category} keyword={keyword} sort={sort} gameVersion={gameVersion} loader={loader} instanceId={instanceId} onInstall={handleInstall} cnName={cnNames[item.title]} />
            ))}
          </div>

          {!initialLoading && !isReplacing && !error && items.length > 0 && (
            items.length < total ? (
              <div className="mt-5 flex justify-center">
                <Button variant="outline" size="sm" onClick={loadMore} disabled={loading} className="min-w-[160px] gap-1.5">
                  {loading ? <><FontAwesomeIcon icon={faRotate} className="h-3 w-3 animate-spin" />{t('resource.loading')}</> : <>{t('resource.loadMore', { current: items.length, total })}</>}
                </Button>
              </div>
            ) : (
              <p className="mt-5 text-center text-xs text-muted-foreground/50">{t('resource.allShown', { count: total })}</p>
            )
          )}
        </>
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
