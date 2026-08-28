import { useCallback, useEffect, useState } from 'react'
import { CloudDownload, Search, Star } from 'lucide-react'
import { RotateCw as RotateCwData } from 'lucide'
import { MorphActionIcon } from './MorphActionIcon.tsx'
import { Button, Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter, Input, Select, SelectOption, Separator, useMessageBox } from './ui'
import { useI18n } from '../i18n/index.tsx'
import { PERMISSION_CATALOG } from '../plugins/types.ts'
import { usePluginStore } from '../stores/pluginStore.ts'
import { PluginIcon } from './PluginIcon.tsx'
import {
  fetchStorePlugin,
  fetchStoreReviews,
  installStorePlugin,
  listStorePlugins,
  type StorePlugin,
  type StorePluginDetail,
  type StoreReview,
} from '../api/pluginStore.ts'

const CATEGORIES = ['', 'tool', 'launcher', 'theme', 'integration']

/** 与后端 version_parse 同语义的宽松版本比较：a > b → 1 */
function compareVersions(a: string, b: string): number {
  const pa = a.split('-')[0]?.split('+')[0]?.split('.').map((s) => parseInt(s, 10) || 0) ?? []
  const pb = b.split('-')[0]?.split('+')[0]?.split('.').map((s) => parseInt(s, 10) || 0) ?? []
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0
    const vb = pb[i] ?? 0
    if (va !== vb) return va < vb ? -1 : 1
  }
  return 0
}

/** 商店 slug ↔ 本地 manifest.id 匹配（id 可能是 top.qomicex.xxx 反域形式） */
function matchesLocalId(slug: string, localId: string): boolean {
  return localId === slug || localId.toLowerCase().endsWith(`.${slug.toLowerCase()}`)
}

interface InstallTarget {
  detail: StorePluginDetail
  version: string
  permissions: string[]
  isUpdate: boolean
  localId?: string
}

export default function PluginStoreBrowse() {
  const { t } = useI18n()
  const { notify } = useMessageBox()
  const { plugins: localPlugins, rescan } = usePluginStore()

  const [items, setItems] = useState<StorePlugin[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(12)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [sort, setSort] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)

  const [installing, setInstalling] = useState(false)
  const [target, setTarget] = useState<InstallTarget | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detail, setDetail] = useState<StorePluginDetail | null>(null)
  const [reviews, setReviews] = useState<StoreReview[]>([])
  const [detailLoading, setDetailLoading] = useState(false)

  const load = useCallback(
    async (p: number) => {
      setLoading(true)
      setLoadError(false)
      try {
        const res = await listStorePlugins({
          q: query.trim() || undefined,
          category: category || undefined,
          sort: sort || undefined,
          page: p,
          pageSize,
        })
        setItems(res.items ?? [])
        setTotal(res.total ?? 0)
        setPage(res.page ?? p)
      } catch {
        setLoadError(true)
        setItems([])
      } finally {
        setLoading(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, category, sort, pageSize]
  )

  useEffect(() => {
    void load(1)
  }, [load])

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  function findLocal(slug: string) {
    return localPlugins.find((p) => matchesLocalId(slug, p.manifest.id))
  }

  function installedVersionOf(item: StorePlugin): string | null {
    const local = findLocal(item.slug)
    return local?.manifest.version ?? null
  }

  function updatableTo(item: StorePlugin): string | null {
    const installed = installedVersionOf(item)
    const latest = item.latestVersion
    if (!installed || !latest) return null
    return compareVersions(latest, installed) > 0 ? latest : null
  }

  async function openInstallConfirm(item: StorePlugin, isUpdate: boolean) {
    try {
      const d = await fetchStorePlugin(item.slug)
      const version = isUpdate ? d.latestVersion ?? item.latestVersion ?? '' : d.latestVersion ?? ''
      const vEntry = d.versions?.find((v) => v.version === version)
      const local = findLocal(item.slug)
      setTarget({
        detail: d,
        version,
        permissions: vEntry?.permissions ?? [],
        isUpdate,
        localId: local?.manifest.id,
      })
    } catch (e) {
      notify(t('settings.plugins.store.installFailed', { message: e instanceof Error ? e.message : String(e) }), 'error')
    }
  }

  async function confirmInstall() {
    if (!target) return
    setInstalling(true)
    try {
      await installStorePlugin(target.detail.slug, target.version || undefined)
      await rescan()
      notify(t('settings.plugins.store.installSuccess'), 'success')
      setTarget(null)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      notify(t('settings.plugins.store.installFailed', { message: msg }), 'error')
    } finally {
      setInstalling(false)
    }
  }

  async function openDetail(item: StorePlugin) {
    setDetailOpen(true)
    setDetailLoading(true)
    setDetail(null)
    setReviews([])
    try {
      const d = await fetchStorePlugin(item.slug)
      setDetail(d)
      const r = await fetchStoreReviews(item.slug, 1, 20).catch(() => ({ items: [] }))
      setReviews(r.items ?? [])
    } catch {
      setDetail(null)
    } finally {
      setDetailLoading(false)
    }
  }

  function permissionRisk(p: string): string {
    return PERMISSION_CATALOG[p]?.risk ?? 'normal'
  }

  const riskColors: Record<string, string> = {
    normal: 'border-blue-500/30 text-blue-400',
    warning: 'border-yellow-500/30 text-yellow-400',
    danger: 'border-red-500/30 text-red-400',
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-4 flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('settings.plugins.store.searchPlaceholder')}
                className="h-8 w-56 pl-8"
              />
            </div>
            <Select value={category} onChange={setCategory} className="h-8 w-32" placeholder={t('settings.plugins.store.categoryAll')}>
              {CATEGORIES.map((c) => (
                <SelectOption key={c || 'all'} value={c}>
                  {c === '' ? t('settings.plugins.store.categoryAll') : t(`settings.plugins.store.category${c.charAt(0).toUpperCase()}${c.slice(1)}`)}
                </SelectOption>
              ))}
            </Select>
            <Select value={sort} onChange={setSort} className="h-8 w-32" placeholder={t('settings.plugins.store.sortLatest')}>
              <SelectOption value="">{t('settings.plugins.store.sortLatest')}</SelectOption>
              <SelectOption value="downloads">{t('settings.plugins.store.sortDownloads')}</SelectOption>
            </Select>
            <Button size="sm" variant="outline" className="ml-auto" onClick={() => void load(page)} disabled={loading}>
              <MorphActionIcon active={loading} busy={RotateCwData} rest={RotateCwData} className="h-3.5 w-3.5" />
              {t('common.refresh')}
            </Button>
          </div>

          {loading ? (
            <p className="py-10 text-center text-muted-foreground">{t('common.loading')}</p>
          ) : loadError ? (
            <div className="flex flex-col items-center gap-3 py-10">
              <p className="text-muted-foreground">{t('settings.plugins.store.loadFailed')}</p>
              <Button size="sm" variant="outline" onClick={() => void load(page)}>{t('common.refresh')}</Button>
            </div>
          ) : items.length === 0 ? (
            <p className="py-10 text-center text-muted-foreground">{t('settings.plugins.store.emptyResult')}</p>
          ) : (
            <>
              <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-2 xl:grid-cols-3">
                {items.map((item) => {
                  const updatable = updatableTo(item)
                  const installed = !!installedVersionOf(item)
                  return (
                    <div
                      key={item.slug}
                      className="flex cursor-pointer flex-col gap-2 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:border-primary/40"
                      onClick={() => void openDetail(item)}
                    >
                      <div className="flex items-start gap-3">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-primary/10">
                          {item.iconUrl ? (
                            <img src={item.iconUrl} alt="" className="h-6 w-6 object-contain" />
                          ) : (
                            <PluginIcon icon="" fallback={item.name.charAt(0).toUpperCase()} className="text-sm font-semibold text-primary" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium">{item.name}</span>
                            {updatable && (
                              <span className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                                {t('settings.plugins.store.updatableBadge', { version: updatable })}
                              </span>
                            )}
                            {installed && !updatable && (
                              <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                {t('settings.plugins.store.installedBadge')}
                              </span>
                            )}
                          </div>
                          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.description}</p>
                        </div>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {(item.tags ?? []).slice(0, 3).map((tag) => (
                          <span key={tag} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{tag}</span>
                        ))}
                        <span className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
                          {typeof item.ratingAverage === 'number' && (
                            <span className="flex items-center gap-1">
                              <Star className="h-3 w-3 text-yellow-500" />
                              {item.ratingAverage.toFixed(1)}
                            </span>
                          )}
                          <span>{t('settings.plugins.store.downloadsCount', { count: item.downloadsCount ?? 0 })}</span>
                        </span>
                      </div>
                      <Button
                        size="sm"
                        variant={updatable ? 'default' : 'outline'}
                        onClick={(e) => {
                          e.stopPropagation()
                          void openInstallConfirm(item, !!updatable)
                        }}
                      >
                        <CloudDownload className="mr-1.5 h-3.5 w-3.5" />
                        {updatable ? t('settings.plugins.store.updateBtn') : installed ? t('settings.plugins.store.reinstallBtn') : t('settings.plugins.store.installBtn')}
                      </Button>
                    </div>
                  )
                })}
              </div>
              {totalPages > 1 && (
                <div className="mt-4 flex items-center justify-center gap-3 text-sm">
                  <Button size="sm" variant="outline" disabled={page <= 1 || loading} onClick={() => void load(page - 1)}>
                    {t('settings.plugins.store.prevPage')}
                  </Button>
                  <span className="text-muted-foreground">{t('settings.plugins.store.pageInfo', { page, total: totalPages })}</span>
                  <Button size="sm" variant="outline" disabled={page >= totalPages || loading} onClick={() => void load(page + 1)}>
                    {t('settings.plugins.store.nextPage')}
                  </Button>
                </div>
              )}
            </>
          )}
      </div>

      {/* 权限确认对话框（安装/更新共用） */}
      <Dialog open={!!target} onClose={() => (installing ? null : setTarget(null))}>
        <DialogHeader onClose={() => (installing ? null : setTarget(null))}>
          <DialogTitle>
            {target?.isUpdate ? t('settings.plugins.store.updateConfirmTitle') : t('settings.plugins.store.installConfirmTitle')}
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          {target && (
            <>
              <p className="text-sm">
                {t('settings.plugins.store.installConfirmDesc', { name: target.detail.name, version: target.version })}
              </p>
              <Separator />
              <div className="space-y-1.5">
                <p className="text-sm text-muted-foreground">{t('settings.plugins.store.permissionsNotice')}</p>
                {target.permissions.length === 0 ? (
                  <p className="text-sm">{t('settings.plugins.store.noPermissions')}</p>
                ) : (
                  target.permissions.map((p) => (
                    <div key={p} className="flex items-center gap-2 text-sm">
                      <span className={`rounded border px-1.5 py-0.5 text-xs ${riskColors[permissionRisk(p)] ?? ''}`}>
                        {permissionRisk(p)}
                      </span>
                      <span>{PERMISSION_CATALOG[p]?.key ? t(PERMISSION_CATALOG[p].key) : p}</span>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setTarget(null)} disabled={installing}>{t('common.cancel')}</Button>
          <Button onClick={() => void confirmInstall()} disabled={installing}>
            {installing ? t('settings.plugins.store.installing') : target?.isUpdate ? t('settings.plugins.store.updateBtn') : t('settings.plugins.store.installBtn')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* 插件详情 + 版本历史 + 只读评价 */}
      <Dialog open={detailOpen} onClose={() => setDetailOpen(false)}>
        <DialogHeader onClose={() => setDetailOpen(false)}>
          <DialogTitle>{detail?.name ?? ''}</DialogTitle>
        </DialogHeader>
        <DialogBody className="max-h-[60vh] space-y-3 overflow-y-auto">
          {detailLoading ? (
            <p className="py-6 text-center text-muted-foreground">{t('common.loading')}</p>
          ) : !detail ? (
            <p className="py-6 text-center text-muted-foreground">{t('settings.plugins.store.loadFailed')}</p>
          ) : (
            <>
              <div className="text-xs text-muted-foreground">
                {detail.slug}{detail.latestVersion ? ` · v${detail.latestVersion}` : ''}
                {detail.developerName ? ` · ${t('settings.plugins.store.developerLabel')} ${detail.developerName}` : ''}
              </div>
              <p className="text-sm">{detail.description}</p>
              <div className="flex flex-wrap gap-1">
                {(detail.tags ?? []).map((tag) => (
                  <span key={tag} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{tag}</span>
                ))}
              </div>
              <Separator />
              {(detail.versions ?? []).length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-sm font-medium">{t('settings.plugins.store.detailVersions')}</p>
                  {detail.versions.slice(0, 10).map((v) => (
                    <div key={v.id} className="rounded border border-border px-3 py-2 text-sm">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">v{v.version}</span>
                        <span className="ml-auto text-[11px] text-muted-foreground">
                          {t('settings.plugins.store.downloadsCount', { count: v.downloadCount ?? 0 })}
                        </span>
                      </div>
                      {v.changelog && <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">{v.changelog}</p>}
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {t('settings.plugins.store.permissionsCount', { count: v.permissions?.length ?? 0 })}
                      </p>
                    </div>
                  ))}
                </div>
              )}
              <Separator />
              <div className="space-y-1.5">
                <p className="text-sm font-medium">{t('settings.plugins.store.detailReviews', { count: reviews.length })}</p>
                {reviews.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('settings.plugins.store.noReviews')}</p>
                ) : (
                  reviews.map((r) => (
                    <div key={r.id} className="rounded border border-border px-3 py-2 text-sm">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{r.username}</span>
                        <span className="flex items-center gap-0.5 text-yellow-500">
                          {Array.from({ length: 5 }, (_, i) => (
                            <Star key={i} className={`h-3 w-3 ${i < r.rating ? '' : 'opacity-25'}`} />
                          ))}
                        </span>
                      </div>
                      {r.content && <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{r.content}</p>}
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setDetailOpen(false)}>{t('common.close')}</Button>
        </DialogFooter>
      </Dialog>
    </div>
  )
}
