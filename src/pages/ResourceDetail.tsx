import { useEffect, useMemo, useState, useCallback } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import remarkGfm from 'remark-gfm'
import { PageHeader } from '../components/PageHeader.tsx'
import {
  faArrowLeft,
  faArrowUpRightFromSquare,
  faDownload,
  faLanguage,
  faLayerGroup,
  faRotate,
  faTag,
  faUser,
  faChevronDown,
} from '@fortawesome/free-solid-svg-icons'
import { Select, SelectOption } from '../components/ui/select.tsx'
import { Button } from '../components/ui/button.tsx'
import { Card, CardContent } from '../components/ui/card.tsx'
import { Badge } from '../components/ui/badge.tsx'
import { useMessageBox } from '../components/ui/message-box.tsx'
import { get } from '../api/client.ts'
import { getResourceDetail, getResourceVersionDownloads, getResourceVersions, startCurseForgeVersionFetch, getCurseForgeVersionFetchProgress, getCurseForgeVersionFetchResult } from '../api/resource.ts'
import { lookupChineseName } from '../api/mcmod.ts'
import { downloadTo } from '../api/resource-download.ts'
import { getInstance, getDefaultInstance } from '../api/instance.ts'
import type { ResourceDetail, ResourceFile, ResourceVersion, GameInstance } from '../types/index.ts'
import { cn } from '../lib/utils.ts'
import { save } from '@tauri-apps/plugin-dialog'


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

function LoaderBadge({ loader }: { loader: string }) {
  const colorMap: Record<string, string> = {
    forge: 'bg-orange-500/10 text-orange-500 border-orange-500/25',
    fabric: 'bg-cyan-500/10 text-cyan-400 border-cyan-400/25',
    neoforge: 'bg-green-500/10 text-green-500 border-green-500/25',
    quilt: 'bg-purple-500/10 text-purple-400 border-purple-400/25',
    liteloader: 'bg-sky-500/10 text-sky-400 border-sky-400/25',
    rift: 'bg-rose-500/10 text-rose-400 border-rose-400/25',
  }

  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none ${colorMap[loader.toLowerCase()] ?? 'bg-muted text-muted-foreground border-border'}`}>
      {loader}
    </span>
  )
}

export default function ResourceDetailPage() {
  const { resourceId } = useParams()
  const [searchParams] = useSearchParams()
  const { notify } = useMessageBox()
  const source = searchParams.get('source') ?? 'modrinth'
  const category = searchParams.get('category') ?? 'mod'
  const keyword = searchParams.get('keyword') ?? ''
  const sort = searchParams.get('sort') ?? 'relevance'
  const instanceIdParam = searchParams.get('instanceId') ?? ''

  const [detail, setDetail] = useState<ResourceDetail | null>(null)
  const [versions, setVersions] = useState<ResourceVersion[]>([])
  const [instance, setInstance] = useState<GameInstance | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingVersions, setLoadingVersions] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [versionsError, setVersionsError] = useState<string | null>(null)
  const [versionFetchProgress, setVersionFetchProgress] = useState<{ loaded: number; total: number } | null>(null)
  const urlGameVersion = searchParams.get('gameVersion') || ''
  const urlLoader = (searchParams.get('loader') || '').toLowerCase()
  const [selectedGameVersion, setSelectedGameVersion] = useState(urlGameVersion || 'all')
  const [selectedLoader, setSelectedLoader] = useState(urlLoader || 'all')
  const [downloadsByVersion, setDownloadsByVersion] = useState<Record<string, ResourceFile[]>>({})
  const [loadingDownloadsFor, setLoadingDownloadsFor] = useState<string | null>(null)
  const [downloadingFor, setDownloadingFor] = useState<string | null>(null)

  const [cnName, setCnName] = useState<string | null>(null)
  const [translation, setTranslation] = useState<{ original: string; translated: string; translatedAt: string } | null>(null)
  const [translating, setTranslating] = useState(false)
  const [visibleCount, setVisibleCount] = useState(0)
  const PAGE_SIZE = 30

  const handleDownload = useCallback(async (versionId: string, url: string, fileName: string) => {
    setDownloadingFor(versionId)
    try {
      const folderMap: Record<string, string> = { mod: 'mods', resourcepack: 'resourcepacks', shaderpack: 'shaderpacks', save: 'saves' }
      const subDir = folderMap[category] || ''
      const defaultDir = instance?.gameDir ? instance.gameDir.replace(/\\/g, '/') + (subDir ? `/${subDir}` : '') : undefined
      const defaultPath = defaultDir ? `${defaultDir}/${fileName}` : fileName
      const targetPath = await save({ defaultPath })
      if (!targetPath) { setDownloadingFor(null); return }
      await downloadTo(url, targetPath)
      notify(`已下载到：${targetPath}`, 'success')
    } catch { notify('下载失败', 'error') }
    setDownloadingFor(null)
  }, [category, instance, notify])

  useEffect(() => {
    if (!resourceId) return
    const id = resourceId

    let cancelled = false

    async function load() {
      setLoading(true)
      setLoadingVersions(true)
      setError(null)
      setVersionsError(null)
      setDownloadsByVersion({})
      setLoadingDownloadsFor(null)
      setTranslation(null)

      // Phase 1: load detail only — show page ASAP
      try {
        const resourceDetail = await getResourceDetail(id, source)
        if (cancelled) return
        setDetail(resourceDetail)
        if (category === 'mod') lookupChineseName(resourceDetail.title).then(setCnName)
        setLoading(false)
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : '加载资源详情失败')
        setLoading(false)
        setLoadingVersions(false)
        return
      }

      // Phase 2: load versions in background
      if (source === 'curseforge') {
        try {
          const { taskId, totalVersionCount, loadedVersionCount } = await startCurseForgeVersionFetch(id)
          if (cancelled) return
          setVersionFetchProgress({ loaded: loadedVersionCount, total: totalVersionCount })

          // poll progress every 500ms
          const pollMs = 500
          const poll = async (): Promise<ResourceVersion[]> => {
            while (true) {
              await new Promise(r => setTimeout(r, pollMs))
              if (cancelled) throw new Error('cancelled')
              const p = await getCurseForgeVersionFetchProgress(taskId)
              if (cancelled) throw new Error('cancelled')
              setVersionFetchProgress({ loaded: p.loadedVersionCount, total: p.totalVersionCount })
              if (p.done) {
                return getCurseForgeVersionFetchResult(taskId)
              }
            }
          }
          const versionList = await poll()
          if (cancelled) return
          setVersions(versionList)
        } catch (e) {
          if (cancelled) return
          setVersionsError(e instanceof Error ? e.message : '加载版本列表失败')
        }
        setVersionFetchProgress(null)
        if (!cancelled) setLoadingVersions(false)
      } else {
        try {
          const versionList = await getResourceVersions(id, source)
          if (cancelled) return
          setVersions(versionList)
        } catch (e) {
          if (cancelled) return
          setVersionsError(e instanceof Error ? e.message : '加载版本列表失败')
        }
        if (!cancelled) setLoadingVersions(false)
      }

      // fetch instance to default version/loader filters and download path
      if (!cancelled) {
        try {
          const inst = instanceIdParam
            ? await getInstance(instanceIdParam)
            : await getDefaultInstance()
          if (inst && !cancelled) {
            setInstance(inst)
            if (inst.loader) {
              const loader = inst.loader.toLowerCase().trim()
              const hasVersion = !inst.gameVersion || versions.some(v => v.gameVersions.includes(inst.gameVersion))
              const hasLoader = versions.some(v => v.loaders.length === 0 || v.loaders.includes(loader))
              if (!urlGameVersion && inst.gameVersion && hasVersion) setSelectedGameVersion(inst.gameVersion)
              if (!urlLoader && hasLoader) setSelectedLoader(loader)
            }
          }
        } catch { /* no instance available */ }
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [resourceId, source])

  const gameVersionOptions = useMemo(() => {
    return ['all', ...new Set(versions.flatMap((version) => version.gameVersions).filter(Boolean))]
  }, [versions])

  const loaderOptions = useMemo(() => {
    return ['all', ...new Set(versions.flatMap((version) => version.loaders).filter(Boolean))]
  }, [versions])

  const filteredVersions = useMemo(() => {
    return versions.filter((version) => {
      const matchesGameVersion = selectedGameVersion === 'all' || version.gameVersions.includes(selectedGameVersion)
      const matchesLoader = selectedLoader === 'all' || version.loaders.length === 0 || version.loaders.includes(selectedLoader)
      return matchesGameVersion && matchesLoader
    })
  }, [selectedGameVersion, selectedLoader, versions])

  useEffect(() => {
    setVisibleCount(PAGE_SIZE)
  }, [versions, selectedGameVersion, selectedLoader])

  const displayedVersions = filteredVersions.slice(0, visibleCount)

  const expandBody = searchParams.get('expandBody') === '1'
  const [bodyCollapsed, setBodyCollapsed] = useState(!expandBody)

  const backQuery = new URLSearchParams()
  backQuery.set('source', source)
  backQuery.set('category', category)
  if (keyword) backQuery.set('keyword', keyword)
  backQuery.set('sort', sort)
  if (urlGameVersion) backQuery.set('gameVersion', urlGameVersion)
  if (urlLoader) backQuery.set('loader', urlLoader)

  const handleLoadDownloads = async (versionId: string) => {
    if (!resourceId || source !== 'ftb' || downloadsByVersion[versionId]) return

    setLoadingDownloadsFor(versionId)
    try {
      const downloads = await getResourceVersionDownloads(resourceId, versionId, source)
      setDownloadsByVersion((current) => ({ ...current, [versionId]: downloads }))
    } finally {
      setLoadingDownloadsFor((current) => current === versionId ? null : current)
    }
  }

  return (
    <div className="animate-in slide-up space-y-6 p-8">
      <PageHeader
        title={
          <>
            <Link to={`/resource-center?${backQuery.toString()}`} className="mr-2 text-sm font-normal text-muted-foreground transition-colors hover:text-foreground">
              <FontAwesomeIcon icon={faArrowLeft} className="mr-1 h-3.5 w-3.5" />
              返回
            </Link>
            资源详情
          </>
        }
        actions={detail?.projectUrl ? (
          <Button asChild variant="outline" size="sm">
            <a href={detail.projectUrl} target="_blank" rel="noopener noreferrer">
              <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="h-3.5 w-3.5" />
              原始页面
            </a>
          </Button>
        ) : undefined}
      />

      {loading ? (
        <Card className="p-8">
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <FontAwesomeIcon icon={faRotate} className="h-4 w-4 animate-spin" />
            正在加载资源详情...
          </div>
        </Card>
      ) : error || !detail ? (
        <Card className="p-8">
          <div className="space-y-2 text-center">
            <p className="text-sm font-medium text-foreground">加载失败</p>
            <p className="text-xs text-muted-foreground">{error ?? '资源不存在'}</p>
          </div>
        </Card>
      ) : (
        <>
          <Card className="overflow-hidden">
            <CardContent className="p-0">
              <div className="grid gap-0 lg:grid-cols-[220px_minmax(0,1fr)]">
                <div className="flex items-start justify-center bg-muted/30 p-6">
                  {detail.iconUrl ? (
                    <img src={detail.iconUrl} alt={detail.title} className="h-36 w-36 rounded-2xl object-cover ring-1 ring-border/50" />
                  ) : (
                    <div className="flex h-36 w-36 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                      <FontAwesomeIcon icon={faLayerGroup} className="h-10 w-10 opacity-50" />
                    </div>
                  )}
                </div>

                <div className="space-y-5 p-6">
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-2xl font-semibold leading-tight">{cnName ? <>{cnName}<span className="ml-1.5 text-sm font-normal text-muted-foreground/60">| {detail.title}</span></> : detail.title}</h2>
                      <Badge variant="secondary">{getSourceLabel(detail.source)}</Badge>
                      {detail.latestVersion && <Badge variant="outline">最新 {detail.latestVersion}</Badge>}
                    </div>
                    <p className="text-sm leading-7 text-muted-foreground">{detail.description || '暂无简介'}</p>
                    {detail.source !== 'ftb' && (
                      <div className="space-y-2">
                        <button
                          onClick={async () => {
                            if (translation) {
                              setTranslation(null)
                              return
                            }
                            setTranslating(true)
                            try {
                              const data = await get<{ original: string; translated: string; translatedAt: string }>(`/resources/${resourceId}/translate?source=${detail.source}`)
                              setTranslation(data)
                            } catch {
                              setTranslation(null)
                            }
                            setTranslating(false)
                          }}
                          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                        >
                          <FontAwesomeIcon icon={faLanguage} className="h-3 w-3" />
                          {translating ? '翻译中...' : translation ? '收起翻译' : '翻译简介'}
                        </button>
                        {translation && (
                          <div className="rounded-lg border border-border/60 bg-muted/20 p-3 text-sm leading-7 text-foreground">
                            <span className="mr-1.5 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">译</span>
                            {translation.translated}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1 rounded-lg bg-muted px-3 py-1.5">
                      <FontAwesomeIcon icon={faUser} className="h-3 w-3" />
                      {detail.author || '未知作者'}
                    </span>
                    <span className="inline-flex items-center gap-1 rounded-lg bg-muted px-3 py-1.5">
                      <FontAwesomeIcon icon={faDownload} className="h-3 w-3" />
                      {formatDownloads(detail.downloadCount)}
                    </span>
                  </div>

                  {detail.categories.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-sm font-medium text-foreground">分类标签</p>
                      <div className="flex flex-wrap gap-2">
                        {detail.categories.map((item) => (
                          <Badge key={item} variant="outline" className="gap-1 rounded-full px-3 py-1">
                            <FontAwesomeIcon icon={faTag} className="h-2.5 w-2.5" />
                            {item}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
            <Card>
              <CardContent className="space-y-4 p-6">
                <div className="space-y-1 flex items-center justify-between">
                  <h3 className="text-lg font-semibold">详细介绍</h3>
                  <button onClick={() => setBodyCollapsed(!bodyCollapsed)} className="flex h-7 items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
                    {bodyCollapsed ? '展开' : '收起'}
                    <FontAwesomeIcon icon={faChevronDown} className={cn('h-3 w-3 transition-transform', !bodyCollapsed && 'rotate-180')} />
                  </button>
                </div>
                <div className={cn('rounded-xl border border-border/60 bg-muted/20 p-4 overflow-hidden transition-all', bodyCollapsed ? 'max-h-[180px] relative' : '')}>
                  {bodyCollapsed && <div className="absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-muted/20 to-transparent pointer-events-none" />}
                  <article className="prose prose-invert prose-sm max-w-none prose-headings:mt-5 prose-headings:mb-3 prose-headings:font-semibold prose-h1:text-2xl prose-h2:text-xl prose-h3:text-lg prose-p:my-3 prose-p:leading-7 prose-ul:my-3 prose-ul:list-disc prose-ul:pl-5 prose-ol:my-3 prose-ol:pl-5 prose-li:my-1.5 prose-strong:text-foreground prose-code:rounded prose-code:bg-background prose-code:px-1 prose-code:py-0.5 prose-code:text-foreground prose-pre:rounded-xl prose-pre:border prose-pre:border-border/60 prose-pre:bg-background prose-a:text-primary hover:prose-a:text-primary/80 prose-img:rounded-xl prose-img:border prose-img:border-border/60 prose-img:shadow-sm prose-hr:border-border/60 prose-blockquote:border-l-primary prose-blockquote:text-muted-foreground break-words">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>
                      {detail.body?.trim() || detail.description || '暂无更多介绍'}
                    </ReactMarkdown>
                  </article>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="space-y-4 p-6">
                <div className="space-y-1">
                  <h3 className="text-lg font-semibold">选择版本安装</h3>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <span className="text-xs text-muted-foreground">游戏版本</span>
                    <Select value={selectedGameVersion} onChange={setSelectedGameVersion}>
                      {gameVersionOptions.map((option) => (
                        <SelectOption key={option} value={option}>{option === 'all' ? '全部版本' : option}</SelectOption>
                      ))}
                    </Select>
                  </div>

                  <div className="space-y-1.5">
                    <span className="text-xs text-muted-foreground">加载器</span>
                    <Select value={selectedLoader} onChange={setSelectedLoader}>
                      {loaderOptions.map((option) => (
                        <SelectOption key={option} value={option}>{option === 'all' ? '全部加载器' : option}</SelectOption>
                      ))}
                    </Select>
                  </div>
                </div>

                <div className="max-h-[540px] space-y-2 overflow-y-auto pr-1">
                  {loadingVersions ? (
                    <div className="space-y-2">
                      {versionFetchProgress && (
                        <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                          <FontAwesomeIcon icon={faRotate} className="h-3 w-3 animate-spin" />
                          正在获取版本列表
                          <span className="font-medium text-foreground/80">
                            {versionFetchProgress.loaded} / {versionFetchProgress.total}
                          </span>
                        </div>
                      )}
                      {Array.from({ length: 4 }).map((_, i) => (
                        <div key={i} className="animate-pulse rounded-xl border border-border/60 bg-background p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1 space-y-2">
                              <div className="h-4 w-3/5 rounded bg-muted" />
                              <div className="h-3 w-2/5 rounded bg-muted" />
                              <div className="flex gap-1.5">
                                <div className="h-5 w-14 rounded-full bg-muted" />
                                <div className="h-5 w-16 rounded-full bg-muted" />
                                <div className="h-5 w-12 rounded-full bg-muted" />
                              </div>
                            </div>
                            <div className="h-8 w-16 shrink-0 rounded-lg bg-muted" />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : versionsError ? (
                    <div className="rounded-xl border border-dashed border-border/60 p-6 text-center text-xs text-muted-foreground">
                      {versionsError}
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>共 {versions.length} 个版本</span>
                        <span>筛选后 {filteredVersions.length} 个</span>
                      </div>

                      {filteredVersions.length === 0 ? (
                        <div className="rounded-xl border border-dashed border-border/60 p-6 text-center text-xs text-muted-foreground">
                          当前筛选条件下没有可用版本
                        </div>
                      ) : (
                        <>
                        {displayedVersions.map((version) => (
                          <div key={version.id} className="rounded-xl border border-border/60 bg-background p-3 transition-colors hover:bg-accent/30">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0 flex-1 space-y-2">
                                <div>
                                  <p className="truncate text-sm font-semibold text-foreground">{version.name || version.versionNumber}</p>
                                  <p className="mt-1 text-xs text-muted-foreground">{version.versionNumber}</p>
                                </div>

                                <div className="flex flex-wrap gap-1.5">
                                  {version.gameVersions.map((gameVersion) => (
                                    <Badge key={gameVersion} variant="outline" className="rounded-full px-2 py-0.5 text-[10px] font-medium">
                                      {gameVersion}
                                    </Badge>
                                  ))}
                                  {version.loaders.map((loader) => (
                                    <LoaderBadge key={loader} loader={loader} />
                                  ))}
                                </div>
                              </div>

                              {source === 'ftb' ? (
                                downloadsByVersion[version.id]?.[0]?.url ? (
                                  <Button
                                    size="sm"
                                    className="shrink-0"
                                    disabled={downloadingFor === version.id}
                                    onClick={() => handleDownload(version.id, downloadsByVersion[version.id][0].url, downloadsByVersion[version.id][0].filename)}
                                  >
                                    <FontAwesomeIcon icon={downloadingFor === version.id ? faRotate : faDownload} className={cn('h-3 w-3', downloadingFor === version.id && 'animate-spin')} />
                                    {downloadingFor === version.id ? '安装中...' : '安装'}
                                  </Button>
                                ) : (
                                  <Button
                                    size="sm"
                                    className="shrink-0"
                                    disabled={loadingDownloadsFor === version.id}
                                    onClick={() => handleLoadDownloads(version.id)}
                                  >
                                    <FontAwesomeIcon icon={faDownload} className="h-3 w-3" />
                                    {loadingDownloadsFor === version.id ? '加载中...' : '获取下载'}
                                  </Button>
                                )
                              ) : version.downloads?.[0]?.url ? (
                                <Button
                                  size="sm"
                                  className="shrink-0"
                                  disabled={downloadingFor === version.id}
                                  onClick={() => handleDownload(version.id, version.downloads[0].url, version.downloads[0].filename)}
                                >
                                  <FontAwesomeIcon icon={downloadingFor === version.id ? faRotate : faDownload} className={cn('h-3 w-3', downloadingFor === version.id && 'animate-spin')} />
                                  {downloadingFor === version.id ? '下载中...' : '安装'}
                                </Button>
                              ) : (
                                <Button
                                  size="sm"
                                  className="shrink-0"
                                  disabled
                                >
                                  <FontAwesomeIcon icon={faDownload} className="h-3 w-3" />
                                  暂无下载
                                </Button>
                              )}
                            </div>
                          </div>
                        ))}
                        {visibleCount < filteredVersions.length && (
                          <button
                            onClick={() => setVisibleCount(prev => prev + PAGE_SIZE)}
                            className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border/60 p-3 text-xs text-muted-foreground transition-colors hover:border-primary/30 hover:text-primary"
                          >
                            <FontAwesomeIcon icon={faChevronDown} className="h-3 w-3" />
                            加载更多 ({filteredVersions.length - visibleCount} 个)
                          </button>
                        )}
                        </>
                      )}
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </>
      )}

    </div>
  )
}
