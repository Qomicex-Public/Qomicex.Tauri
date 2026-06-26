import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faArrowUpRightFromSquare,
  faDownload,
  faMagnifyingGlass,
  faRotate,
  faTag,
  faUser,
} from '@fortawesome/free-solid-svg-icons'
import { Input } from '../components/ui/input.tsx'
import { PageHeader } from '../components/PageHeader.tsx'
import { Button } from '../components/ui/button.tsx'
import { Card } from '../components/ui/card.tsx'
import { Badge } from '../components/ui/badge.tsx'
import { Select, SelectOption } from '../components/ui/select.tsx'
import { searchResources } from '../api/resource.ts'
import type { ResourceItem } from '../types/index.ts'

const CATEGORIES = [
  { key: 'mod', label: '模组' },
  { key: 'modpack', label: '整合包' },
  { key: 'shader', label: '光影' },
  { key: 'resourcepack', label: '材质包' },
  { key: 'datapack', label: '数据包' },
]

const SOURCES = [
  { key: 'modrinth', label: 'Modrinth' },
  { key: 'curseforge', label: 'CurseForge' },
  { key: 'ftb', label: 'FTB' },
]

const SORT_OPTIONS: Record<string, { key: string; label: string }[]> = {
  modrinth: [
    { key: 'relevance', label: '相关度' },
    { key: 'downloads', label: '下载量' },
    { key: 'updated', label: '更新时间' },
    { key: 'newest', label: '最新发布' },
  ],
  curseforge: [
    { key: 'downloads', label: '下载量' },
    { key: 'updated', label: '更新时间' },
    { key: 'name', label: '名称' },
    { key: 'newest', label: '最新发布' },
  ],
  ftb: [
    { key: 'relevance', label: '推荐' },
    { key: 'downloads', label: '安装量' },
    { key: 'updated', label: '更新时间' },
    { key: 'name', label: '名称' },
    { key: 'newest', label: '最新发布' },
  ],
}

function cn(...classes: (string | boolean | undefined | null)[]): string {
  return classes.filter(Boolean).join(' ')
}

function formatDownloads(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function getSourceLabel(source: string): string {
  const map: Record<string, string> = {
    modrinth: 'Modrinth',
    curseforge: 'CurseForge',
    ftb: 'FTB',
  }
  return map[source] ?? source
}

function buildDetailUrl(item: ResourceItem, category: string, keyword: string, sort: string): string {
  const params = new URLSearchParams()
  params.set('source', item.source)
  params.set('category', category)
  params.set('sort', sort)
  if (keyword) params.set('keyword', keyword)
  return `/resource-center/${encodeURIComponent(item.id)}?${params.toString()}`
}

function ResourceCard({
  item,
  category,
  keyword,
  sort,
  onInstall,
}: {
  item: ResourceItem
  category: string
  keyword: string
  sort: string
  onInstall: (item: ResourceItem) => void
}) {
  return (
    <Card className="group overflow-hidden border-border/60 bg-card/95 transition-all hover:border-primary/20 hover:shadow-lg hover:shadow-primary/5">
      <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start">
        <div className="flex min-w-0 flex-1 gap-4">
          {item.iconUrl ? (
            <img
              src={item.iconUrl}
              alt={item.title}
              className="h-16 w-16 flex-shrink-0 rounded-2xl object-cover ring-1 ring-border/40"
              loading="lazy"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
            />
          ) : (
            <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
              <FontAwesomeIcon icon={faTag} className="h-5 w-5 opacity-50" />
            </div>
          )}

          <div className="min-w-0 flex-1 space-y-3">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-base font-semibold text-foreground">{item.title}</h3>
                <Badge variant="secondary" className="rounded-full px-2.5 py-0.5">{getSourceLabel(item.source)}</Badge>
                {item.latestVersion && <Badge variant="outline" className="rounded-full px-2.5 py-0.5">{item.latestVersion}</Badge>}
              </div>
              <p className="line-clamp-2 text-sm leading-6 text-muted-foreground">{item.description}</p>
            </div>

            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <FontAwesomeIcon icon={faUser} className="h-3 w-3" />
                {item.author || '未知作者'}
              </span>
              <span className="inline-flex items-center gap-1">
                <FontAwesomeIcon icon={faDownload} className="h-3 w-3" />
                {formatDownloads(item.downloadCount)}
              </span>
            </div>

            {item.categories.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {item.categories.slice(0, 6).map((tag) => (
                  <Badge key={tag} variant="outline" className="rounded-full px-2.5 py-0.5 text-[11px] font-medium">
                    {tag}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-row gap-2 sm:min-w-[148px] sm:flex-col sm:items-stretch sm:self-stretch">
          <Button className="flex-1 sm:w-full" onClick={() => onInstall(item)}>
            <FontAwesomeIcon icon={faDownload} className="h-3 w-3" />
            安装
          </Button>
          <Button asChild variant="outline" className="flex-1 sm:w-full">
            <a href={buildDetailUrl(item, category, keyword, sort)}>
              查看详情
            </a>
          </Button>
          {item.projectUrl && (
            <Button asChild variant="ghost" className="px-3 sm:w-full">
              <a href={item.projectUrl} target="_blank" rel="noopener noreferrer">
                <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="h-3 w-3" />
                原站
              </a>
            </Button>
          )}
        </div>
      </div>
    </Card>
  )
}

export default function ResourceCenter() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const [category, setCategory] = useState(searchParams.get('category') ?? 'mod')
  const [source, setSource] = useState(searchParams.get('source') ?? 'modrinth')
  const [keyword, setKeyword] = useState(searchParams.get('keyword') ?? '')
  const [searchInput, setSearchInput] = useState(searchParams.get('keyword') ?? '')
  const [sort, setSort] = useState(searchParams.get('sort') ?? 'relevance')
  const [items, setItems] = useState<ResourceItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [initialLoading, setInitialLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const pageSize = 20

  useEffect(() => {
    const params = new URLSearchParams()
    params.set('source', source)
    params.set('category', category)
    params.set('sort', sort)
    if (keyword) params.set('keyword', keyword)
    setSearchParams(params, { replace: true })
  }, [category, keyword, setSearchParams, sort, source])

  const doSearch = useCallback(async (pageNum: number, append: boolean) => {
    setLoading(true)
    setError(null)
    try {
      const res = await searchResources({
        category,
        keyword: keyword || undefined,
        page: pageNum,
        pageSize,
        sort,
        source,
      })
      setItems((prev) => append ? [...prev, ...res.items] : res.items)
      setTotal(res.total)
      setPage(pageNum)
    } catch (e) {
      const msg = e instanceof Error ? e.message : '搜索失败'
      if (msg.includes('404') || msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
        setError('无法连接到后端服务，请确保后端已启动')
      } else {
        setError(msg)
      }
      if (!append) setItems([])
    }
    setLoading(false)
    setInitialLoading(false)
  }, [category, keyword, sort, source])

  useEffect(() => {
    setInitialLoading(true)
    setItems([])
    setPage(1)
    doSearch(1, false)
  }, [doSearch])

  const handleSearch = () => setKeyword(searchInput.trim())

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch()
  }

  const handleCategoryChange = (nextCategory: string) => {
    if (source === 'ftb' && nextCategory !== 'modpack') return
    setCategory(nextCategory)
  }

  const handleSourceChange = (nextSource: string) => {
    setSource(nextSource)
    if (nextSource === 'ftb') {
      setCategory('modpack')
      setSort('relevance')
      return
    }
    setSort(nextSource === 'curseforge' ? 'downloads' : 'relevance')
  }

  const handleInstall = (item: ResourceItem) => {
    navigate(buildDetailUrl(item, category, keyword, sort))
  }

  const loadMore = () => {
    if (!loading && items.length < total) doSearch(page + 1, true)
  }

  const currentSortOptions = SORT_OPTIONS[source] ?? SORT_OPTIONS.modrinth
  const activeCategoryLabel = useMemo(() => CATEGORIES.find((item) => item.key === category)?.label ?? category, [category])

  return (
    <div className="animate-in slide-up space-y-6 p-8">
      <PageHeader title="资源中心" subtitle="先筛选资源，再点右侧「安装」进入详情页选择版本。" />

      <Card className="border-border/60 bg-muted/20 p-4">
        <div className="space-y-4">
          <div className="flex flex-wrap items-start gap-4 xl:items-center xl:justify-between">
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground/70">资源源</p>
              <div className="flex flex-wrap gap-2">
                {SOURCES.map((f) => (
                  <button
                    key={f.key}
                    onClick={() => handleSourceChange(f.key)}
                    className={cn(
                      'h-9 rounded-md px-4 text-sm font-medium transition-all',
                      source === f.key
                        ? 'bg-primary text-primary-foreground shadow-sm'
                        : 'bg-background text-muted-foreground hover:bg-accent hover:text-foreground'
                    )}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2 xl:ml-auto">
              <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground/70">资源分类</p>
              <div className="flex flex-wrap gap-2">
                {CATEGORIES.map((item) => (
                  <button
                    key={item.key}
                    onClick={() => handleCategoryChange(item.key)}
                    disabled={source === 'ftb' && item.key !== 'modpack'}
                    className={cn(
                      'h-9 rounded-md px-4 text-sm font-medium transition-all',
                      category === item.key
                        ? 'bg-primary text-primary-foreground shadow-sm'
                        : 'bg-background text-muted-foreground hover:bg-accent hover:text-foreground',
                      source === 'ftb' && item.key !== 'modpack' && 'cursor-not-allowed opacity-40 hover:bg-background hover:text-muted-foreground'
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_180px_110px]">
            <div className="relative">
              <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
              <Input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={`搜索${activeCategoryLabel}...`}
                className="h-10 rounded-xl border-border/60 bg-background pl-9"
              />
            </div>

            <Select value={sort} onChange={setSort} className="h-10">
              {currentSortOptions.map((item) => (
                <SelectOption key={item.key} value={item.key}>{item.label}</SelectOption>
              ))}
            </Select>

            <Button onClick={handleSearch} className="h-10 rounded-xl">
              <FontAwesomeIcon icon={faMagnifyingGlass} className="h-3.5 w-3.5" />
              搜索
            </Button>
          </div>
        </div>
      </Card>

      <div>
        {initialLoading ? (
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
            <p className="text-sm font-medium text-foreground/80">搜索失败</p>
            <p className="mt-1 text-xs text-muted-foreground/60">{error}</p>
            <Button size="sm" variant="outline" onClick={() => doSearch(1, false)} className="mt-4">
              <FontAwesomeIcon icon={faRotate} className="mr-1.5 h-3 w-3" />
              重试
            </Button>
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted">
              <FontAwesomeIcon icon={faMagnifyingGlass} className="h-6 w-6 opacity-40" />
            </div>
            <p className="text-sm font-medium text-foreground/80">未找到相关资源</p>
            <p className="mt-1 text-xs text-muted-foreground/60">尝试更换关键词、资源源或分类</p>
          </div>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 px-0.5">
              <p className="text-sm text-muted-foreground">
                当前显示 <span className="font-medium text-foreground">{activeCategoryLabel}</span>，共 <span className="font-medium text-foreground">{total}</span> 个结果
              </p>
              {page > 1 && <p className="text-xs text-muted-foreground/70">已加载 {items.length} 个</p>}
            </div>

            <div className="flex flex-col gap-3">
              {items.map((item) => (
                <ResourceCard
                  key={`${item.source}-${item.id}`}
                  item={item}
                  category={category}
                  keyword={keyword}
                  sort={sort}
                  onInstall={handleInstall}
                />
              ))}
            </div>

            {items.length < total ? (
              <div className="mt-5 flex justify-center">
                <Button variant="outline" size="sm" onClick={loadMore} disabled={loading} className="min-w-[160px] gap-1.5">
                  {loading ? (
                    <><FontAwesomeIcon icon={faRotate} className="h-3 w-3 animate-spin" />加载中...</>
                  ) : (
                    <>加载更多（{items.length}/{total}）</>
                  )}
                </Button>
              </div>
            ) : (
              <p className="mt-5 text-center text-xs text-muted-foreground/50">已显示全部 {total} 个结果</p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
