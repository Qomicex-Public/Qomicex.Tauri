import { useEffect, useMemo, useState, useCallback } from 'react'
import { Link, useParams, useSearchParams, useLocation } from 'react-router-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import remarkGfm from 'remark-gfm'
import { PageHeader } from '../components/PageHeader.tsx'
import { PageShell } from '../components/PageShell.tsx'
import { Button } from '../components/ui'
import { MinecraftText } from '../components/MinecraftText.tsx'
import {
  faArrowLeft,
  faArrowUpRightFromSquare,
  faDownload,
  faFloppyDisk,
  faLanguage,
  faLayerGroup,
  faRotate,
  faTag,
  faUser,
  faChevronDown,
} from '@fortawesome/free-solid-svg-icons'
import { Select, SelectOption } from '../components/ui'
import { Card, CardContent } from '../components/ui'
import { Badge } from '../components/ui'
import { Tooltip } from '../components/ui'
import { useMessageBox } from '../components/ui'
import { get, post, API_BASE } from '../api/client.ts'
import { getResourceDetail, getResourceVersionDownloads, getResourceVersions, getResourceDependencies, startCurseForgeVersionFetch, getCurseForgeVersionFetchProgress, getCurseForgeVersionFetchResult } from '../api/resource.ts'
import { lookupChineseName } from '../api/mcmod.ts'
import { translateCategory } from '../lib/categoryTranslations.ts'
import { downloadTo } from '../api/resource-download.ts'
import { getInstance, getDefaultInstance } from '../api/instance.ts'
import type { ResourceDetail, ResourceFile, ResourceVersion, GameInstance, ResolvedDependency } from '../types/index.ts'
import { addTask } from '../stores/downloadStore.ts'
import { cn } from '../lib/utils.ts'
import { cacheGet, cacheSet, cacheInvalidate } from '../lib/simple-cache.ts'
import { save } from '@tauri-apps/plugin-dialog'
import { loadSettings } from '../api/settings.ts'
import ModpackInstallDialog from '../components/ModpackInstallDialog.tsx'
import ResourceInstallDialog from '../components/ResourceInstallDialog.tsx'
import { useI18n } from '../i18n/index.tsx'

/**
 * 解析一个资源的中文名：优先用标题精确匹配（CurseForge 标题常带括号后缀，
 * 后端 lookup 已对末尾括号后缀做剥离 fallback），标题未命中时退回用 slug。
 */
async function resolveCnName(title: string, slug?: string): Promise<string | null> {
  const cn = await lookupChineseName(title)
  if (cn) return cn
  if (slug && slug.trim()) return lookupChineseName(slug)
  return null
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

function DependenciesCard({ resourceId, source, versions, gameVersion, loader }: {
  resourceId: string
  source: string
  versions: ResourceVersion[]
  gameVersion: string
  loader: string
}) {
  const [deps, setDeps] = useState<ResolvedDependency[] | null>(null)
  const { t } = useI18n()
  const latest = versions[0]
  const latestId = latest?.id
  const latestNumber = latest?.versionNumber

  useEffect(() => {
    if (!latestId) { setDeps(null); return }
    let cancelled = false
    setDeps(null)
    getResourceDependencies(
      resourceId, source, latestId,
      gameVersion === 'all' ? '' : gameVersion,
      loader === 'all' ? undefined : loader
    )
      .then(d => { if (!cancelled) setDeps(d.filter(x => x.projectId !== resourceId)) })
      .catch(() => { if (!cancelled) setDeps([]) })
    return () => { cancelled = true }
  }, [resourceId, source, latestId, gameVersion, loader])

  if (!latestId) return null
  return (
    <Card>
      <CardContent className="space-y-3 p-6">
        <div className="flex items-baseline justify-between">
          <h3 className="text-lg font-semibold">{t('resourceDetail.prereqMods')}</h3>
          <span className="text-[11px] text-muted-foreground/60">{t('resourceDetail.basedOn', { version: latestNumber ?? '' })}</span>
        </div>
        {deps === null ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <FontAwesomeIcon icon={faRotate} className="h-3 w-3 animate-spin" />
            {t('resourceDetail.parsingPrereq')}
          </div>
        ) : deps.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('resourceDetail.noPrereq')}</p>
        ) : (
          <div className="grid gap-1.5">
            {deps.map(d => (
              <Link
                key={d.projectId}
                to={`/resource-center/${encodeURIComponent(d.projectId)}?source=${d.source || 'modrinth'}&category=mod`}
                className="flex items-center gap-2.5 rounded-lg border border-border/60 bg-background px-3 py-2 text-xs transition-colors hover:bg-accent/30"
              >
                {d.iconUrl ? (
                  <img src={d.iconUrl} alt="" className="h-6 w-6 rounded object-cover" loading="lazy" />
                ) : (
                  <div className="flex h-6 w-6 items-center justify-center rounded bg-muted text-muted-foreground">
                    <FontAwesomeIcon icon={faLayerGroup} className="h-3 w-3" />
                  </div>
                )}
                <span className="min-w-0 flex-1 truncate font-medium">{d.name}</span>
                <span className="max-w-[45%] shrink-0 truncate text-muted-foreground">{d.versionNumber}</span>
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default function ResourceDetailPage() {
  const { resourceId } = useParams()
  const [searchParams] = useSearchParams()
  const location = useLocation()
  const navIconUrl = (location.state as { iconUrl?: string } | null)?.iconUrl
  const { notify } = useMessageBox()
  const { t, lang } = useI18n()
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

  const [modpackInstallVersion, setModpackInstallVersion] = useState<ResourceVersion | null>(null)
  const [installVersion, setInstallVersion] = useState<ResourceVersion | null>(null)
  const [modpackGameDir, setModpackGameDir] = useState('')
  const [modpackIsolation, setModpackIsolation] = useState(true)
  const [cnName, setCnName] = useState<string | null>(null)
  const [translation, setTranslation] = useState<{ original: string; translated: string; translatedAt: string } | null>(null)
  const [translating, setTranslating] = useState(false)
  const [bodyTranslation, setBodyTranslation] = useState<string | null>(null)
  const [translatingBody, setTranslatingBody] = useState(false)
  const [visibleCount, setVisibleCount] = useState(0)
  const [detailRefreshKey, setDetailRefreshKey] = useState(0)
  const PAGE_SIZE = 30

  const refreshDetail = useCallback(() => {
    cacheInvalidate('api-resource-detail')
    cacheInvalidate('api-resource-versions')
    setDetailRefreshKey(k => k + 1)
  }, [])

  const handleDownload = useCallback(async (versionId: string, url: string, fileName: string) => {
    // Everything awaited must stay inside the try: a rejection from the CurseForge
    // URL refresh or from the save dialog would otherwise be an unhandled rejection
    // and the button would silently do nothing.
    try {
      let downloadUrl = url
      let targetName = fileName
      if (source === 'curseforge' && resourceId) {
        const fresh = await getResourceVersionDownloads(resourceId, versionId, source)
        if (fresh?.[0]?.url) downloadUrl = fresh[0].url
        // The backend resolves the authoritative file name alongside the fresh URL;
        // prefer it over the (possibly cached) name from the version list.
        if (fresh?.[0]?.fileName) targetName = fresh[0].fileName
      }
      const folderMap: Record<string, string> = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks', save: 'saves', datapack: 'datapacks' }
      const subDir = folderMap[category] || ''
      let defaultPath = targetName
      if (instance && subDir) {
        const base = instance.gameDir.replace(/\\/g, '/')
        const isolated = instance.versionIsolation ?? true
        const vn = instance.name
        const dir = isolated ? `${base}/versions/${vn}/${subDir}` : `${base}/${subDir}`
        defaultPath = `${dir}/${targetName}`
      }
      const targetPath = await save({ defaultPath })
      if (!targetPath) return
      const { taskId } = await downloadTo(downloadUrl, targetPath)
      addTask({
        id: taskId,
        name: targetName,
        type: 'file',
        gameVersion: '',
        status: 'queued',
        progress: 0,
        taskId,
        currentFile: targetName,
        icon: detail?.iconUrl,
        createdAt: new Date().toISOString(),
      })
      notify(t('resourceDetail.addedToDownload'), 'success')
    } catch {
      notify(t('resourceDetail.downloadFailed'), 'error')
    }
  }, [source, resourceId, category, instance, detail, notify, t])

  const handleFtbExportJson = useCallback(async (versionId: string, versionName: string) => {
    const exportUrl = `${API_BASE}/api/resources/ftb/${resourceId}/export?versionId=${encodeURIComponent(versionId)}`
    const fileName = `${detail?.title || 'modpack'}-${versionName}.json`
    try {
      const targetPath = await save({ defaultPath: fileName })
      if (!targetPath) return
      const { taskId } = await downloadTo(exportUrl, targetPath)
      addTask({
        id: taskId,
        name: fileName,
        type: 'file',
        gameVersion: '',
        status: 'queued',
        progress: 0,
        taskId,
        currentFile: fileName,
        icon: detail?.iconUrl,
        createdAt: new Date().toISOString(),
      })
      notify(t('resourceDetail.addedToDownload'), 'success')
    } catch {
      notify(t('resourceDetail.exportFailed'), 'error')
    }
  }, [resourceId, detail, notify, t])

  // Effect A: load detail only — show page ASAP, versions load independently
  useEffect(() => {
    if (!resourceId) return
    const id = resourceId

    let cancelled = false

    async function loadDetail() {
      setLoading(true)
      setError(null)
      setTranslation(null)
      setBodyTranslation(null)
      try {
        const cacheKey = `api-resource-detail-${id}-${source}`
        const cached = cacheGet<ResourceDetail>(cacheKey)
        if (cached) {
          setDetail(cached); setLoading(false)
          // 缓存命中时立即查中文名：网络请求失败/慢时标题也不缺翻译
          if (category === 'mod') resolveCnName(cached.title, cached.slug).then(setCnName)
        }
        const resourceDetail = await getResourceDetail(id, source, category)
        if (cancelled) return
        setDetail(resourceDetail)
        cacheSet(cacheKey, resourceDetail)
        if (category === 'mod') resolveCnName(resourceDetail.title, resourceDetail.slug).then(setCnName)
        setLoading(false)
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : t('resourceDetail.loadDetailFailed'))
        setLoading(false)
      }
    }

    loadDetail()
    return () => { cancelled = true }
  }, [resourceId, source, category, detailRefreshKey])

  // Effect B: load versions + default instance filters (independent of detail)
  useEffect(() => {
    if (!resourceId) return
    const id = resourceId

    let cancelled = false
    let abortController: AbortController | undefined

    async function loadVersions() {
      setLoadingVersions(true)
      setVersionsError(null)
      setDownloadsByVersion({})
      setLoadingDownloadsFor(null)

      const cacheKey = `api-resource-versions-${id}-${source}`
      const cached = cacheGet<ResourceVersion[]>(cacheKey)
      if (cached) setVersions(cached)

      let versionList: ResourceVersion[] = []
      if (source === 'curseforge') {
        try {
          const { taskId, totalVersionCount, loadedVersionCount } = await startCurseForgeVersionFetch(id)
          if (cancelled) return
          setVersionFetchProgress({ loaded: loadedVersionCount, total: totalVersionCount })

          // Poll progress every 500ms, with a hard deadline so a backend task that
          // never reaches `done` (e.g. a panicked worker) can't leave us polling forever.
          const pollMs = 500
          const pollDeadline = Date.now() + 5 * 60 * 1000
          abortController = new AbortController()
          const poll = async (): Promise<ResourceVersion[]> => {
            while (true) {
              await new Promise((resolve, reject) => {
                const timer = setTimeout(resolve, pollMs)
                abortController!.signal.addEventListener('abort', () => {
                  clearTimeout(timer)
                  reject(new Error('cancelled'))
                }, { once: true })
              })
              if (abortController!.signal.aborted) throw new Error('cancelled')
              const p = await getCurseForgeVersionFetchProgress(taskId)
              if (abortController!.signal.aborted) throw new Error('cancelled')
              setVersionFetchProgress({ loaded: p.loadedVersionCount, total: p.totalVersionCount })
              // A failed fetch reports done with an error; treating it as success
              // would render an empty list as "this resource has no versions".
              if (p.error) throw new Error(p.error)
              if (p.done) {
                return getCurseForgeVersionFetchResult(taskId)
              }
              if (Date.now() > pollDeadline) throw new Error(t('resourceDetail.loadVersionsTimeout'))
            }
          }
          versionList = await poll()
          if (cancelled) return
          setVersions(versionList)
          cacheSet(cacheKey, versionList)
        } catch (e) {
          if (cancelled) return
          setVersionsError(e instanceof Error ? e.message : t('resourceDetail.loadVersionsFailed'))
        }
        setVersionFetchProgress(null)
        if (!cancelled) setLoadingVersions(false)
      } else {
        try {
          versionList = await getResourceVersions(id, source)
          if (cancelled) return
          setVersions(versionList)
          cacheSet(cacheKey, versionList)
        } catch (e) {
          if (cancelled) return
          setVersionsError(e instanceof Error ? e.message : t('resourceDetail.loadVersionsFailed'))
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
              const hasVersion = !inst.gameVersion || versionList.some(v => v.gameVersions.includes(inst.gameVersion))
              const hasLoader = versionList.some(v => v.loaders.length === 0 || v.loaders.includes(loader))
              if (!urlGameVersion && inst.gameVersion && hasVersion) setSelectedGameVersion(inst.gameVersion)
              if (!urlLoader && hasLoader) setSelectedLoader(loader)
            }
          }
        } catch { /* no instance available */ }
      }
    }

    loadVersions()
    return () => { cancelled = true; abortController?.abort() }
  }, [resourceId, source, instanceIdParam, urlGameVersion, urlLoader, detailRefreshKey])

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
    <PageShell>
      <div className="shrink-0 px-8 pt-8">
        <PageHeader
          title={
            <>
              <Link to={`/resource-center?${backQuery.toString()}`} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-all duration-200 hover:bg-accent hover:text-foreground active:scale-95">
                <FontAwesomeIcon icon={faArrowLeft} className="h-4 w-4" />
              </Link>
              <span className="ml-2">{t('resourceDetail.title')}</span>
            </>
          }
          actions={
            <div className="flex items-center gap-2">
              <Tooltip content={t('resourceDetail.refresh')}>
                <Button variant="outline" size="sm" onClick={refreshDetail}>
                  <FontAwesomeIcon icon={faRotate} className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
                </Button>
              </Tooltip>
              {detail?.projectUrl ? (
                <Button asChild variant="outline" size="sm">
                  <a href={detail.projectUrl} target="_blank" rel="noopener noreferrer">
                    <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="h-3.5 w-3.5" />
                    {t('resourceDetail.originalPage')}
                  </a>
                </Button>
              ) : null}
            </div>
          }
        />
      </div>
      
      <div className="flex-1 min-h-0 overflow-y-auto scroll-fade-mask">
        <div className="space-y-6 p-8">

      {loading ? (
        <div className="space-y-6">
          <Card className="overflow-hidden">
            <CardContent className="p-0">
              <div className="grid gap-0 lg:grid-cols-[220px_minmax(0,1fr)]">
                <div className="flex items-start justify-center bg-muted/30 p-6">
                  <div className="h-36 w-36 animate-pulse rounded-2xl bg-muted" />
                </div>
                <div className="space-y-5 p-6">
                  <div className="space-y-3">
                    <div className="h-7 w-2/3 animate-pulse rounded bg-muted" />
                    <div className="h-4 w-full animate-pulse rounded bg-muted" />
                    <div className="h-4 w-5/6 animate-pulse rounded bg-muted" />
                  </div>
                  <div className="flex gap-2">
                    <div className="h-8 w-24 animate-pulse rounded-lg bg-muted" />
                    <div className="h-8 w-24 animate-pulse rounded-lg bg-muted" />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
            <Card>
              <CardContent className="space-y-4 p-6">
                <div className="h-6 w-28 animate-pulse rounded bg-muted" />
                <div className="space-y-2">
                  <div className="h-3 w-full animate-pulse rounded bg-muted" />
                  <div className="h-3 w-5/6 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="space-y-4 p-6">
                <div className="h-6 w-32 animate-pulse rounded bg-muted" />
                <div className="space-y-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="h-16 animate-pulse rounded-xl bg-muted" />
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      ) : error || !detail ? (
        <Card className="p-8">
          <div className="space-y-2 text-center">
            <p className="text-sm font-medium text-foreground">{t('resourceDetail.loadFailed')}</p>
            <p className="text-xs text-muted-foreground">{error ?? t('resourceDetail.notFound')}</p>
          </div>
        </Card>
      ) : (
        <>
          <Card className="overflow-hidden">
            <CardContent className="p-0">
              <div className="grid gap-0 lg:grid-cols-[220px_minmax(0,1fr)]">
                <div className="flex items-start justify-center bg-muted/30 p-6">
                  {detail.iconUrl || navIconUrl ? (
                    <img src={detail.iconUrl || navIconUrl} alt={detail.title} className="h-36 w-36 rounded-2xl object-cover ring-1 ring-border/50" />
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
                      {detail.latestVersion && <Badge variant="outline">{t('resourceDetail.latest', { version: detail.latestVersion })}</Badge>}
                    </div>
                    <MinecraftText text={detail.description || t('resourceDetail.noDescription')} className="text-sm leading-7 text-muted-foreground" />
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
                          {translating ? t('resourceDetail.translating') : translation ? t('resourceDetail.collapseTranslation') : t('resourceDetail.translateDescription')}
                        </button>
                        {translation && (
                          <div className="rounded-lg border border-border/60 bg-muted/20 p-3 text-sm leading-7 text-foreground">
                            <span className="mr-1.5 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">{t('resourceDetail.translatedMark')}</span>
                            {translation.translated}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1 rounded-lg bg-muted px-3 py-1.5">
                      <FontAwesomeIcon icon={faUser} className="h-3 w-3" />
                      {detail.author || t('resourceDetail.unknownAuthor')}
                    </span>
                    <span className="inline-flex items-center gap-1 rounded-lg bg-muted px-3 py-1.5">
                      <FontAwesomeIcon icon={faDownload} className="h-3 w-3" />
                      {formatDownloads(detail.downloadCount)}
                    </span>
                  </div>

                  {detail.categories.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-sm font-medium text-foreground">{t('resourceDetail.categoryTags')}</p>
                      <div className="flex flex-wrap gap-2">
                        {detail.categories.map((item) => (
                          <Badge key={item} variant="outline" className="gap-1 rounded-full px-3 py-1">
                            <FontAwesomeIcon icon={faTag} className="h-2.5 w-2.5" />
                            {translateCategory(item, detail.source, lang)}
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
                  <h3 className="text-lg font-semibold">{t('resourceDetail.detailedIntro')}</h3>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={async () => {
                        if (bodyTranslation) {
                          setBodyTranslation(null)
                          return
                        }
                        const bodyText = detail.body?.trim() || detail.description
                        if (!bodyText) return
                        setTranslatingBody(true)
                        try {
                          const data = await post<{ original: string; translated: string }>('/resources/translate-text', { text: bodyText })
                          setBodyTranslation(data.translated)
                        } catch {
                          setBodyTranslation(null)
                        }
                        setTranslatingBody(false)
                      }}
                      className="flex h-7 items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <FontAwesomeIcon icon={faLanguage} className="h-3 w-3" />
                      {translatingBody ? t('resourceDetail.translating') : bodyTranslation ? t('resourceDetail.showOriginal') : t('resourceDetail.translateBody')}
                    </button>
                    <button onClick={() => setBodyCollapsed(!bodyCollapsed)} className="flex h-7 items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
                      {bodyCollapsed ? t('resourceDetail.expand') : t('resourceDetail.collapse')}
                      <FontAwesomeIcon icon={faChevronDown} className={cn('h-3 w-3 transition-transform', !bodyCollapsed && 'rotate-180')} />
                    </button>
                  </div>
                </div>
                <div className={cn('rounded-xl border border-border/60 bg-muted/20 p-4 overflow-hidden transition-all', bodyCollapsed ? 'max-h-[180px] relative' : '')}>
                  {bodyCollapsed && <div className="absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-muted/20 to-transparent pointer-events-none" />}
                  {bodyTranslation ? (
                    <article className="prose prose-invert prose-sm max-w-none prose-headings:mt-5 prose-headings:mb-3 prose-headings:font-semibold prose-h1:text-2xl prose-h2:text-xl prose-h3:text-lg prose-p:my-3 prose-p:leading-7 prose-ul:my-3 prose-ul:list-disc prose-ul:pl-5 prose-ol:my-3 prose-ol:pl-5 prose-li:my-1.5 prose-strong:text-foreground prose-code:rounded prose-code:bg-background prose-code:px-1 prose-code:py-0.5 prose-code:text-foreground prose-pre:rounded-xl prose-pre:border prose-pre:border-border/60 prose-pre:bg-background prose-a:text-primary hover:prose-a:text-primary/80 prose-img:rounded-xl prose-img:border prose-img:border-border/60 prose-img:shadow-sm prose-hr:border-border/60 prose-blockquote:border-l-primary prose-blockquote:text-muted-foreground break-words">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>
                        {bodyTranslation}
                      </ReactMarkdown>
                    </article>
                  ) : (
                    <article className="prose prose-invert prose-sm max-w-none prose-headings:mt-5 prose-headings:mb-3 prose-headings:font-semibold prose-h1:text-2xl prose-h2:text-xl prose-h3:text-lg prose-p:my-3 prose-p:leading-7 prose-ul:my-3 prose-ul:list-disc prose-ul:pl-5 prose-ol:my-3 prose-ol:pl-5 prose-li:my-1.5 prose-strong:text-foreground prose-code:rounded prose-code:bg-background prose-code:px-1 prose-code:py-0.5 prose-code:text-foreground prose-pre:rounded-xl prose-pre:border prose-pre:border-border/60 prose-pre:bg-background prose-a:text-primary hover:prose-a:text-primary/80 prose-img:rounded-xl prose-img:border prose-img:border-border/60 prose-img:shadow-sm prose-hr:border-border/60 prose-blockquote:border-l-primary prose-blockquote:text-muted-foreground break-words">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>
                        {detail.body?.trim() || detail.description || t('resourceDetail.noMoreContent')}
                      </ReactMarkdown>
                    </article>
                  )}
                </div>
              </CardContent>
            </Card>

            <div className="space-y-6">
              {category === 'mod' && !loadingVersions && !versionsError && resourceId && (
                <DependenciesCard
                  resourceId={resourceId}
                  source={source}
                  versions={filteredVersions}
                  gameVersion={selectedGameVersion}
                  loader={selectedLoader}
                />
              )}

            <Card>
              <CardContent className="space-y-4 p-6">
                <div className="space-y-1">
                  <h3 className="text-lg font-semibold">{t('resourceDetail.selectVersionInstall')}</h3>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <span className="text-xs text-muted-foreground">{t('resourceDetail.gameVersion')}</span>
                    <Select value={selectedGameVersion} onChange={setSelectedGameVersion}>
                      {gameVersionOptions.map((option) => (
                        <SelectOption key={option} value={option}>{option === 'all' ? t('resourceDetail.allVersions') : option}</SelectOption>
                      ))}
                    </Select>
                  </div>

                  <div className="space-y-1.5">
                    <span className="text-xs text-muted-foreground">{t('resourceDetail.loader')}</span>
                    <Select value={selectedLoader} onChange={setSelectedLoader}>
                      {loaderOptions.map((option) => (
                        <SelectOption key={option} value={option}>{option === 'all' ? t('resourceDetail.allLoaders') : option}</SelectOption>
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
                          {t('resourceDetail.fetchingVersions')}
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
                        <span>{t('resourceDetail.versionCount', { count: versions.length })}</span>
                        <span>{t('resourceDetail.filteredCount', { count: filteredVersions.length })}</span>
                      </div>

                      {filteredVersions.length === 0 ? (
                        <div className="rounded-xl border border-dashed border-border/60 p-6 text-center text-xs text-muted-foreground">
                          {t('resourceDetail.noVersionUnderFilter')}
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

                              {category === 'modpack' ? (
                                <div className="flex shrink-0 gap-1.5">
                                  <Button
                                    size="sm"
                                    onClick={async () => {
                                      const settings = await loadSettings()
                                      setModpackGameDir(settings.gameDir)
                                      setModpackIsolation(settings.versionIsolation ?? true)
                                      setModpackInstallVersion(version)
                                    }}
                                  >
                                    <FontAwesomeIcon icon={faDownload} className="h-3 w-3" />
                                    {t('resourceDetail.install')}
                                  </Button>
                                  <Tooltip content={t('resourceDetail.saveAs')}>
                                    {source === 'ftb' ? (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => handleFtbExportJson(version.id, version.name)}
                                      >
                                        <FontAwesomeIcon icon={faFloppyDisk} className="h-3 w-3" />
                                      </Button>
                                    ) : version.downloads?.[0]?.url ? (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => handleDownload(version.id, version.downloads[0].url, version.downloads[0].fileName)}
                                      >
                                        <FontAwesomeIcon icon={faFloppyDisk} className="h-3 w-3" />
                                      </Button>
                                    ) : null}
                                  </Tooltip>
                                </div>
                              ) : source === 'ftb' ? (
                                downloadsByVersion[version.id]?.[0]?.url ? (
                                  <Button
                                    size="sm"
                                    className="shrink-0"
                                    onClick={() => handleDownload(version.id, downloadsByVersion[version.id][0].url, downloadsByVersion[version.id][0].fileName)}
                                  >
                                    <FontAwesomeIcon icon={faDownload} className="h-3 w-3" />
                                    {t('resourceDetail.install')}
                                  </Button>
                                ) : (
                                  <Button
                                    size="sm"
                                    className="shrink-0"
                                    disabled={loadingDownloadsFor === version.id}
                                    onClick={() => handleLoadDownloads(version.id)}
                                  >
                                    <FontAwesomeIcon icon={faDownload} className="h-3 w-3" />
                                    {loadingDownloadsFor === version.id ? t('resourceDetail.loading') : t('resourceDetail.getDownload')}
                                  </Button>
                                )
                              ) : version.downloads?.[0]?.url ? (
                                <div className="flex shrink-0 gap-1.5">
                                  <Button
                                    size="sm"
                                    onClick={() => setInstallVersion(version)}
                                  >
                                    <FontAwesomeIcon icon={faDownload} className="h-3 w-3" />
                                    {t('resourceDetail.install')}
                                  </Button>
                                  <Tooltip content={t('resourceDetail.saveAs')}>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() => handleDownload(version.id, version.downloads[0].url, version.downloads[0].fileName)}
                                    >
                                      <FontAwesomeIcon icon={faFloppyDisk} className="h-3 w-3" />
                                    </Button>
                                  </Tooltip>
                                </div>
                              ) : (
                                <Button
                                  size="sm"
                                  className="shrink-0"
                                  disabled
                                >
                                  <FontAwesomeIcon icon={faDownload} className="h-3 w-3" />
                                  {t('resourceDetail.noDownload')}
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
                            {t('resourceDetail.loadMore', { count: filteredVersions.length - visibleCount })}
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
          </div>
        </>
      )}
        </div>
      </div>

      {modpackInstallVersion && (
        <ModpackInstallDialog
          open={!!modpackInstallVersion}
          onClose={() => setModpackInstallVersion(null)}
          modpackName={detail?.title || modpackInstallVersion.name || ''}
          projectId={resourceId || ''}
          source={source}
          selectedVersion={modpackInstallVersion}
          gameDir={modpackGameDir}
          versionIsolation={modpackIsolation}
        />
      )}

      {installVersion && (
        <ResourceInstallDialog
          open={!!installVersion}
          onClose={() => setInstallVersion(null)}
          resourceId={resourceId || ''}
          resourceTitle={detail?.title || ''}
          resourceIcon={detail?.iconUrl || ''}
          source={source}
          category={category}
          instanceId={instanceIdParam || undefined}
          initialVersionId={installVersion.id}
        />
      )}
    </PageShell>
  )
}
