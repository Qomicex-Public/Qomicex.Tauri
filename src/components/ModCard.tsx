import { useCallback, useState, useRef, useEffect, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Box, Check, Ellipsis } from 'lucide-react'
import { Card, CardContent, Switch, Checkbox, Popover } from './ui'
import { Tooltip } from './ui'
import { ContextMenu, ContextMenuItem } from './ContextMenu.tsx'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from './ui'
import { Button } from './ui'
import { cn } from '../lib/utils.ts'
import { formatBytes } from '../lib/download-format.ts'
import { MinecraftText } from './MinecraftText.tsx'
import { enableMod, disableMod, deleteMod } from '../api/instance-files.ts'
import { updateModsViaDownloadCenter } from '../lib/updateMods.ts'
import { openUrl, openPath } from '@tauri-apps/plugin-opener'
import { useMessageBox } from './ui'
import { useI18n } from '../i18n/index.tsx'
import type { ModMetadata, ModUpdateEntry } from '../types/index.ts'

/**
 * 列表模式，两种模式有明确的信息差（不是同一布局放大缩小）：
 * - compact  日常管理：三列对齐（名称 / 英文名 / 版本）+ 开关
 * - detailed 查看信息：compact 的全部 + 描述 + 状态行（大小·日期·来源·状态徽标）
 */
export type ModViewMode = 'compact' | 'detailed'

/** 状态行日期统一为 YYYY/MM/DD（比本地化长格式更易纵向扫视） */
function formatDateSlash(iso: string): string | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`
}

interface ModCardProps {
  mod: ModMetadata
  instanceId: string
  gameVersion?: string
  loader?: string
  onRefresh: () => void
  onToggle: (fileName: string) => void
  onChangeVersion: (mod: ModMetadata) => void
  selected?: boolean
  onSelect?: (fileName: string, shiftKey: boolean, ctrlKey: boolean) => void
  update?: ModUpdateEntry
  /** 单个模组更新完成后回调（用于移除更新标记） */
  onUpdated?: (fileName: string) => void
  /** Mod 文件夹绝对路径（更多菜单「打开 Mod 文件夹」用） */
  modsDir?: string
  /** 列表模式，默认 compact */
  viewMode?: ModViewMode
  /**
   * 批量选择模式：true 时常驻显示复选框；false 时复选框仅在 Hover / 已选中时淡入。
   * 由父级在「有选中项」或用户显式进入多选时置 true。
   */
  selectMode?: boolean
}

export default function ModCard({
  mod, instanceId, gameVersion, loader, onRefresh, onToggle, onChangeVersion,
  selected, onSelect, update, onUpdated, modsDir, viewMode = 'compact', selectMode = false,
}: ModCardProps) {
  const { t, lang } = useI18n()
  const navigate = useNavigate()
  const { notify } = useMessageBox()
  const hasUpdate = !!update
  const [toggling, setToggling] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [imgError, setImgError] = useState(false)
  const iconRef = useRef<HTMLDivElement>(null)
  const [iconVisible, setIconVisible] = useState(false)
  const detailed = viewMode === 'detailed'
  const [menuOpen, setMenuOpen] = useState(false)

  const handleToggle = useCallback(async () => {
    const wasActive = mod.active
    setToggling(true)
    try {
      if (wasActive) {
        await disableMod(instanceId, mod.fileName)
      } else {
        const disabledName = mod.fileName.endsWith('.disabled') ? mod.fileName : mod.fileName + '.disabled'
        await enableMod(instanceId, disabledName)
      }
      onToggle(mod.fileName)
    } catch (e) { console.error('Toggle mod failed:', e) }
    setToggling(false)
  }, [instanceId, mod, onToggle])

  const handleDelete = useCallback(async () => {
    setDeleting(true)
    setConfirmDelete(false)
    try {
      await deleteMod(instanceId, mod.fileName)
      onRefresh()
    } catch (e) { console.error('Delete mod failed:', e) }
    setDeleting(false)
  }, [instanceId, mod, onRefresh])

  useEffect(() => {
    if (!iconRef.current) return
    const el = iconRef.current
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setIconVisible(true); observer.disconnect() }
    }, { rootMargin: '200px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // 资源详情页地址：仅当反查到远程 id 时可用（否则不渲染成链接）
  const remoteId = mod.curseForgeId?.toString() ?? mod.modrinthId ?? null
  const openDetail = useCallback(() => {
    if (!remoteId) return
    const params = new URLSearchParams()
    params.set('source', mod.source || 'modrinth')
    params.set('category', 'mod')
    if (gameVersion) params.set('gameVersion', gameVersion)
    if (loader) params.set('loader', loader.toLowerCase())
    if (instanceId) params.set('instanceId', instanceId)
    params.set('from', 'instance')
    const iconUrl = mod.iconUrl || (mod.iconBase64 ? `data:image/png;base64,${mod.iconBase64}` : '')
    navigate(`/resource-center/${encodeURIComponent(remoteId)}?${params.toString()}&expandBody=1`, { state: { iconUrl } })
  }, [remoteId, mod.source, mod.iconUrl, mod.iconBase64, gameVersion, loader, instanceId, navigate])

  const contextItems: ContextMenuItem[] = []
  if (mod.mcmodId) {
    contextItems.push({
      label: t('dialogs.mod.mcwiki'),
      onClick: () => openUrl(`https://www.mcmod.cn/class/${mod.mcmodId}`),
    })
  }
  if (remoteId) {
    contextItems.push({ label: t('dialogs.common.viewDetail'), onClick: openDetail })
  }
  contextItems.push(
    { label: t('instanceDetail.mods.openModsFolder'), onClick: () => { if (modsDir) openPath(modsDir).catch(() => {}) } },
    { label: t('dialogs.mod.changeVersion'), onClick: () => onChangeVersion(mod) },
    {
      label: t('dialogs.mod.update'),
      disabled: !update,
      onClick: async () => {
        if (!update) return
        try {
          const result = await updateModsViaDownloadCenter(instanceId, [update], () => notify(t('dialogs.mod.addedToDownloadList'), 'success'), t)
          onUpdated?.(update.fileName)
          onRefresh()
          if (result.failed === 0) notify(t('dialogs.mod.updatedWithName', { name: mod.name }), 'success')
          else notify(t('dialogs.mod.updateFailedWithName', { name: mod.name }), 'error')
        } catch { notify(t('dialogs.mod.updateFailed'), 'error') }
      },
    },
    { label: t('common.delete'), onClick: () => setConfirmDelete(true), danger: true },
  )

  // 三列数据：中文环境 = 中文名 / 英文名 / 版本；非中文环境 = 名称 / 版本（两列）。
  // 注意：列结构由「语言」决定而非「该 Mod 是否有中文名」——否则缺中文名的行会少一列、
  // 整列轨道逐行错位。无中文名时英文名落在第一列、第二列留空（与 Sable 那种行一致）。
  const zhLocale = lang.startsWith('zh')
  const hasCn = zhLocale && !!mod.chineseName
  const nameText = hasCn ? mod.chineseName! : mod.name
  const sourceText = hasCn ? mod.name : ''
  const version = mod.version || t('dialogs.mod.unknownVersion')

  // 复选框：默认完全隐藏，Hover / 已选中 / 批量选择模式时从左侧淡入。
  // 用「绝对定位 + 容器 padding 过渡」而非 flex 占位：折叠时不残留 gap 空隙，
  // 展开时由 padding 让出空间，名称列平滑右移且不会与图标重叠。
  const checkbox = onSelect ? (
    <div
      className={cn(
        'absolute left-2.5 top-1/2 z-10 -translate-y-1/2 transition-all duration-200',
        selectMode || selected
          ? 'opacity-100 scale-100'
          : 'pointer-events-none opacity-0 scale-90 group-hover:pointer-events-auto group-hover:opacity-100 group-hover:scale-100 focus-within:pointer-events-auto focus-within:opacity-100'
      )}
      onClick={(e) => {
        // 复选框独立于卡片选中逻辑：阻止冒泡避免二次 toggle（一次点击 = 一次状态切换）
        e.stopPropagation()
        onSelect(mod.fileName, e.shiftKey, true)
      }}
    >
      <Checkbox
        checked={!!selected}
        aria-label={t('instanceDetail.mods.selectMod', { name: mod.name })}
      />
    </div>
  ) : null

  const updateDot = hasUpdate ? (
    <Tooltip content={update ? t('dialogs.mod.updateAvailableTo', { version: update.latestVersion }) : ''}>
      <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-blue-500" />
    </Tooltip>
  ) : null

  // 启用/禁用开关。
  // 降噪：默认半透明 + 略缩小，Hover/选中时恢复全对比度——避免 100+ 行形成一整列亮绿。
  // Tooltip 文案描述当前状态，aria-label 描述点击后的结果（动词）。
  const toggleSwitch = (
    <div
      className={cn(
        'shrink-0 scale-90 transition-all duration-200 group-hover:scale-100 group-hover:opacity-100',
        selected ? 'opacity-100' : 'opacity-60'
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <Tooltip content={mod.active ? t('common.enabled') : t('common.disabled')}>
        <Switch
          checked={mod.active}
          onCheckedChange={() => handleToggle()}
          disabled={toggling}
          aria-label={mod.active ? t('instanceDetail.mods.disable') : t('instanceDetail.mods.enable')}
        />
      </Tooltip>
    </div>
  )

  // 行内「更多」菜单：把原先只有右键才能触发的操作暴露出来（Hover/聚焦时显现）。
  const moreMenu = (
    <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
      <Popover
        open={menuOpen}
        onOpenChange={setMenuOpen}
        align="end"
        contentClassName="min-w-[180px]"
        trigger={
          <button
            type="button"
            aria-label={t('instanceDetail.mods.moreActions')}
            className={cn('flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring', menuOpen ? 'opacity-100' : 'opacity-0')}
          >
            <Ellipsis className="h-4 w-4" />
          </button>
        }
      >
        <div className="flex flex-col">
          {contextItems.map((item, i) => (
            <button
              key={i}
              type="button"
              disabled={item.disabled}
              onClick={() => { item.onClick(); setMenuOpen(false) }}
              className={cn(
                'flex w-full items-center rounded-md px-3 py-2 text-left text-sm transition-colors',
                item.danger
                  ? 'text-destructive hover:bg-destructive/10'
                  : 'text-popover-foreground hover:bg-accent',
                item.disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent'
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </Popover>
    </div>
  )

  const selectionBar = (
    <div className={cn('absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-primary transition-all duration-200', selected ? 'scale-y-100 opacity-100' : 'scale-y-0 opacity-0')} />
  )

  const icon = (sizeClass: string, fallbackClass: string) => (
    <div ref={iconRef} className={cn('flex shrink-0 items-center justify-center overflow-hidden bg-muted text-muted-foreground', sizeClass)}>
      {iconVisible ? (
        mod.iconBase64 ? (
          <img src={`data:image/png;base64,${mod.iconBase64}`} alt={mod.name} className="h-full w-full object-cover" loading="lazy" />
        ) : mod.iconUrl && !imgError ? (
          <img src={mod.iconUrl} alt={mod.name} className="h-full w-full object-cover" loading="lazy" onError={() => setImgError(true)} />
        ) : (
          <Box className={cn(fallbackClass, 'opacity-50')} />
        )
      ) : (
        <Box className={cn(fallbackClass, 'opacity-50')} />
      )}
    </div>
  )

  // 状态行（详细模式）：作者 · 大小 · 日期 · 来源（可点击）· 状态徽标
  const metaNodes: ReactNode[] = []
  if (mod.authors.length > 0) metaNodes.push(mod.authors[0])
  const sizeText = formatBytes(mod.fileSize)
  if (sizeText) metaNodes.push(sizeText)
  const dateText = mod.lastModified ? formatDateSlash(mod.lastModified) : null
  if (dateText) metaNodes.push(dateText)
  if (mod.source) {
    const sourceLabel = mod.source === 'curseforge' ? 'CurseForge' : mod.source === 'modrinth' ? 'Modrinth' : mod.source
    metaNodes.push(
      remoteId ? (
        <button
          key="source"
          type="button"
          onClick={(e) => { e.stopPropagation(); openDetail() }}
          className="rounded text-muted-foreground underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground"
        >
          {sourceLabel}
        </button>
      ) : sourceLabel
    )
  }

  // 状态徽标：可更新（有 update 条目）/ 启用状态。
  // 注意：暂无「依赖缺失」类问题状态——ModMetadata 没有依赖字段，后端也不返回，
  // 有数据源后再在此处扩展，不伪造状态。
  const statusBadges = (
    <>
      {hasUpdate && (
        <span className="inline-flex items-center rounded border border-blue-500/30 bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-500">
          {t('instanceDetail.mods.updatable')}
        </span>
      )}
      <span className={cn(
        'inline-flex items-center gap-0.5 rounded border px-1.5 py-0.5 text-[10px] font-medium',
        mod.active
          ? 'border-primary/25 bg-primary/10 text-primary'
          : 'border-border bg-muted text-muted-foreground'
      )}>
        {mod.active && <Check className="h-2.5 w-2.5" />}
        {mod.active ? t('common.enabled') : t('common.disabled')}
      </span>
    </>
  )

  return (
    <>
      <ContextMenu items={contextItems}>
        <Card
          className={cn(
            'group cursor-pointer select-none border-border/60 bg-card/95 transition-all hover:border-primary/20 hover:shadow-sm',
            detailed ? 'mod-row-detailed' : 'mod-row-compact rounded-lg',
            selected && 'border-primary/40 bg-primary/[0.03]'
          )}
          onClick={(e) => onSelect?.(mod.fileName, e.shiftKey, e.ctrlKey || e.metaKey)}
        >
          {detailed ? (
            <CardContent className={cn(
              'relative flex items-center gap-4 p-4 transition-[padding] duration-200',
              (selectMode || selected) ? 'pl-10' : 'group-hover:pl-10 focus-within:pl-10'
            )}>
              {selectionBar}
              {checkbox}
              {icon('h-12 w-12 rounded-xl', 'h-5 w-5')}
              {/* 禁用态只弱化内容；复选框/开关保持全对比度（否则看不清选中状态） */}
              <div className={cn('min-w-0 flex-1', !mod.active && 'opacity-50')}>
                <div className="flex items-center gap-2">
                  <h3 className="truncate text-sm font-semibold text-foreground leading-snug">
                    {nameText}
                    {sourceText && <span className="ml-1.5 text-[11px] font-normal text-muted-foreground/70">{sourceText}</span>}
                  </h3>
                  {updateDot}
                  <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">{version}</span>
                </div>
                {mod.description && mod.description !== 'No description available' && (
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground/70">
                    <MinecraftText text={mod.description} />
                  </p>
                )}
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                  {metaNodes.map((node, i) => (
                    <span key={i} className="flex items-center gap-2">
                      {i > 0 && <span className="text-border">·</span>}
                      {node}
                    </span>
                  ))}
                  {/* 分隔符仅在前有元信息时渲染，避免出现孤立的 · */}
                  {metaNodes.length > 0 && <span className="text-border">·</span>}
                  {statusBadges}
                </div>
              </div>
              {moreMenu}
              {toggleSwitch}
            </CardContent>
          ) : (
            <CardContent className={cn(
              'relative flex items-center gap-2.5 px-2.5 py-2 transition-[padding] duration-200',
              (selectMode || selected) ? 'pl-9' : 'group-hover:pl-9 focus-within:pl-9'
            )}>
              {selectionBar}
              {checkbox}
              {icon('h-7 w-7 rounded-md', 'h-3.5 w-3.5')}
              {/* 固定列轨道：中文环境 3 列（名称/英文名/版本），其它语言 2 列（名称/版本）。
                  所有行共用同一列宽 → 版本沿同一条垂直线排列，可纵向扫视；
                  中间空间由列分配而非留白，行末不留大空隙。 */}
              <div className={cn(
                'grid min-w-0 flex-1 items-center gap-2',
                zhLocale ? 'grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_7rem]' : 'grid-cols-[minmax(0,1fr)_7rem]',
                !mod.active && 'opacity-50'
              )}>
                <h3 className="truncate text-xs font-medium text-foreground">{nameText}</h3>
                {zhLocale && <span className="truncate text-[11px] text-muted-foreground/70">{sourceText}</span>}
                <Tooltip content={version}>
                  <span className="truncate text-[11px] tabular-nums text-muted-foreground">{version}</span>
                </Tooltip>
              </div>
              {/* 更新标记：固定宽度槽位（无更新时也占位），避免圆点出现/消失挤动版本列 */}
              <span className="flex w-2.5 shrink-0 justify-center">{updateDot}</span>
              {moreMenu}
              {toggleSwitch}
            </CardContent>
          )}
        </Card>
      </ContextMenu>

      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)}>
        <DialogHeader onClose={() => setConfirmDelete(false)}>
          <DialogTitle>{t('dialogs.confirmDelete.titleMod')}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm text-muted-foreground">{t('dialogs.confirmDelete.bodyMod', { name: mod.name })}</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</Button>
          <Button size="sm" variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting ? t('dialogs.common.deleting') : t('common.delete')}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  )
}
