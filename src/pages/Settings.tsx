import React, { useState, useEffect, useCallback, useRef } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faRocket, faMicrochip, faPalette, faInfoCircle, faKey, faFolderOpen, faSliders, faCheck, faXmark, faMagnifyingGlass, faBolt, faPlus, faDownload, faRotate, faFolder, faTrashCan, faTag, faDesktop, faRobot } from '@fortawesome/free-solid-svg-icons'
import { Button } from '../components/ui/button.tsx'
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card.tsx'
import { Input } from '../components/ui/input.tsx'
import { Label } from '../components/ui/label.tsx'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from '../components/ui/dialog.tsx'
import { Badge } from '../components/ui/badge.tsx'
import { Select, SelectOption } from '../components/ui/select.tsx'
import { Tooltip } from '../components/ui/tooltip.tsx'
import { Checkbox } from '../components/ui/checkbox.tsx'
import { PageHeader } from '../components/PageHeader.tsx'
import { useMessageBox } from '../components/ui/message-box.tsx'
import { cn } from '../lib/utils.ts'
import type { SystemInfo } from '../types/index.ts'
import { generateRoomCode, validateRoomCode } from '../api/roomCode.ts'
import { searchJava, validateJavaPath } from '../api/java.ts'
import { getSystemInfo } from '../api/system.ts'
import { open as tauriOpen } from '@tauri-apps/plugin-dialog'
import { revealItemInDir, openPath } from '@tauri-apps/plugin-opener'
import type { JavaRuntime } from '../types/index.ts'

const CATEGORIES = [
  { id: 'launcher', label: '启动器', icon: faRocket },
  { id: 'java', label: 'Java 运行时', icon: faMicrochip },
  { id: 'appearance', label: '显示', icon: faPalette },
  { id: 'roomcode', label: '联机房间码', icon: faKey },
  { id: 'about', label: '关于', icon: faInfoCircle },
]

interface AppSettings {
  gameDir: string
  downloadThreads: number
  versionIsolation: boolean
  closeAfterLaunch: boolean
  memoryMode: 'auto' | 'custom'
  defaultMaxMemory: number
  jvmArgs: string
  language: string
  defaultJavaPath: string
  downloadSource: number
  downloadTimeout: number
  animationsEnabled: boolean
  animationSpeed: number
}

const DOWNLOAD_SOURCES = [
  { value: 0, label: '官方源' },
  { value: 1, label: 'BMCLAPI 镜像' },
]

const DEFAULT_SETTINGS: AppSettings = {
  gameDir: '.minecraft',
  downloadThreads: 4,
  versionIsolation: true,
  closeAfterLaunch: false,
  memoryMode: 'auto',
  defaultMaxMemory: 4096,
  jvmArgs: '',
  language: 'zh-CN',
  defaultJavaPath: '',
  downloadSource: 0,
  downloadTimeout: 15,
  animationsEnabled: true,
  animationSpeed: 1,
}

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem('qomicex-settings')
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch {}
  return DEFAULT_SETTINGS
}

function saveSettings(settings: AppSettings) {
  localStorage.setItem('qomicex-settings', JSON.stringify(settings))
  const enabled = settings.animationsEnabled !== false
  const speed = settings.animationSpeed ?? 1
  document.documentElement.dataset.animEnabled = String(enabled)
  document.documentElement.style.setProperty('--anim-duration-multiplier', String(1 / speed))
}

export default function Settings() {
  const { error: msgError, confirm: msgConfirm } = useMessageBox()
  const [category, setCategory] = useState('launcher')
  const [settings, setSettings] = useState<AppSettings>(loadSettings)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const [saved, setSaved] = useState(false)

  const [sysInfo, setSysInfo] = useState<SystemInfo | null>(null)
  const [runtimes, setRuntimes] = useState<JavaRuntime[]>([])
  const [scanning, setScanning] = useState<'idle' | 'quick' | 'deep'>('idle')
  const [javaStatus, setJavaStatus] = useState('就绪')
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [addPath, setAddPath] = useState('')
  const [adding, setAdding] = useState(false)
  const autoScanRef = useRef(false)

  const [roomCode, setRoomCode] = useState('')
  const [validationCode, setValidationCode] = useState('')
  const [validationResult, setValidationResult] = useState<boolean | null>(null)

  useEffect(() => {
    if (saved) {
      const t = setTimeout(() => setSaved(false), 2000)
      return () => clearTimeout(t)
    }
  }, [saved])

  function update<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    const next = { ...settings, [key]: value }
    setSettings(next)
    saveSettings(next)
    setSaved(true)
  }

  const validCount = runtimes.filter((j) => j.state === 'Valid').length

  useEffect(() => {
    let timer: ReturnType<typeof setInterval>
    function refresh() {
      getSystemInfo().then((info) => {
        setSysInfo(info)
        const cur = settingsRef.current
        if (cur.memoryMode === 'auto') {
          const autoVal = Math.max(512, Math.floor(info.availableMemory * 0.7))
          if (autoVal !== cur.defaultMaxMemory) {
            const next = { ...cur, defaultMaxMemory: autoVal }
            setSettings(next)
            saveSettings(next)
          }
        }
      }).catch(() => {})
    }
    refresh()
    timer = setInterval(refresh, 5000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (settings.memoryMode === 'auto') {
      const autoVal = Math.max(512, Math.floor((sysInfo?.availableMemory ?? 0) * 0.7))
      if (autoVal !== settings.defaultMaxMemory) {
        const next = { ...settings, defaultMaxMemory: autoVal }
        setSettings(next)
        saveSettings(next)
      }
    }
  }, [settings.memoryMode])

  useEffect(() => {
    if (category === 'java' && !autoScanRef.current) {
      autoScanRef.current = true
      handleScan('quick')
    }
  }, [category])

  const handleScan = useCallback(async (mode: 'quick' | 'deep') => {
    setScanning(mode)
    setJavaStatus(mode === 'quick' ? '正在快速扫描...' : '正在深度扫描...')
    try {
      const result = await searchJava()
      setRuntimes((prev) => {
        const merged = [...prev]
        for (const r of result) {
          if (!merged.some((m) => m.path === r.path)) merged.push(r)
        }
        return merged
      })
      const newCount = runtimes.length === 0 ? result.length : result.filter((r) => !runtimes.some((m) => m.path === r.path)).length
      setJavaStatus(newCount > 0 ? `扫描完成，发现 ${newCount} 个新版` : '扫描完成，无新版')
    } catch (e) {
      setJavaStatus('扫描失败')
      console.error(e)
    } finally {
      setScanning('idle')
    }
  }, [runtimes])

  function handleRefresh() {
    setJavaStatus('正在刷新...')
    handleScan('quick')
  }

  function handleOpenFolder(path: string) {
    revealItemInDir(path).catch(() => {
      const dir = path.replace(/[/\\][^/\\]+$/i, '')
      openPath(dir).catch(() => {})
    })
  }

  function handleManualAdd() {
    setAddPath('')
    setAddDialogOpen(true)
  }

  async function handleBrowseJava() {
    try {
      const selected: unknown = await tauriOpen({
        multiple: false,
        title: '选择 Java 可执行文件',
        filters: [{ name: 'Java', extensions: ['exe', ''] }],
      })
      if (typeof selected === 'string') setAddPath(selected)
    } catch {}
  }

  async function confirmAddJava() {
    if (!addPath) return
    setAdding(true)
    try {
      const result = await validateJavaPath(addPath)
      setRuntimes((prev) => {
        const exists = prev.some((j) => j.path === result.path)
        return exists ? prev : [...prev, result]
      })
      setJavaStatus(`已添加 ${result.name} ${result.version}`)
      setAddDialogOpen(false)
    } catch {
      setJavaStatus('无法识别该路径下的 Java 运行时')
    } finally {
      setAdding(false)
    }
  }

  async function handleDelete(path: string) {
    const name = runtimes.find((j) => j.path === path)?.name || ''
    const ok = await msgConfirm(`确定要删除 "${name}" 吗？`, '删除 Java')
    if (!ok) return
    setRuntimes((prev) => prev.filter((j) => j.path !== path))
    if (settings.defaultJavaPath === path) {
      update('defaultJavaPath', '')
    }
    setJavaStatus(`已删除 ${name}`)
  }

  async function handleGenerate() {
    try {
      const result = await generateRoomCode()
      setRoomCode(result.code)
    } catch (e: unknown) {
      await msgError(e instanceof Error ? e.message : '生成失败')
    }
  }

  async function handleValidate() {
    if (!validationCode.trim()) return
    try {
      const result = await validateRoomCode(validationCode)
      setValidationResult(result.valid)
    } catch {
      setValidationResult(false)
    }
  }

  return (
    <div className="animate-in slide-up space-y-6 p-8">
      <PageHeader title="设置" />

      <div className="flex gap-4">
        <div className="flex w-48 shrink-0 flex-col gap-0.5">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setCategory(cat.id)}
              className={cn(
                'flex items-center gap-2.5 rounded-lg px-3.5 py-2.5 text-left text-sm transition-colors',
                category === cat.id
                  ? 'bg-primary/10 font-medium text-primary'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
            >
              <FontAwesomeIcon icon={cat.icon} className="h-4 w-4" />
              {cat.label}
            </button>
          ))}
        </div>

        <div className="flex-1 space-y-4">
          {category === 'launcher' && (
            <div key="launcher" className="animate-in slide-up">
            <Card>
              <CardHeader>
                <CardTitle>
                  <FontAwesomeIcon icon={faRocket} className="mr-2 h-4 w-4 text-primary" />
                  启动器设置
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="space-y-2">
                  <Label htmlFor="gameDir">游戏目录</Label>
                  <div className="flex gap-2">
                    <Input id="gameDir" value={settings.gameDir} onChange={(e) => update('gameDir', e.target.value)} className="flex-1" />
                    <Button variant="outline" size="icon">
                      <FontAwesomeIcon icon={faFolderOpen} className="h-4 w-4" />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">Minecraft 游戏文件存储位置</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="downloadThreads">下载线程数</Label>
                  <Input
                    id="downloadThreads"
                    type="number"
                    min={1}
                    max={512}
                    value={settings.downloadThreads}
                    onChange={(e) => update('downloadThreads', Math.max(1, Math.min(512, parseInt(e.target.value) || 1)))}
                  />
                  <p className="text-xs text-muted-foreground">同时下载的文件数量（1-512），数值越大下载越快但占用带宽越多</p>
                </div>

                <label className="flex items-center gap-3 cursor-pointer">
                  <Checkbox
                    checked={settings.versionIsolation}
                    onCheckedChange={(c) => update('versionIsolation', c === true)}
                  />
                  <div>
                    <div className="text-sm font-medium">版本隔离</div>
                    <div className="text-xs text-muted-foreground">每个版本使用独立的 mods/config/saves 目录，推荐保持开启</div>
                  </div>
                </label>

                <label className="flex items-center gap-3 cursor-pointer">
                  <Checkbox
                    checked={settings.closeAfterLaunch}
                    onCheckedChange={(c) => update('closeAfterLaunch', c === true)}
                  />
                  <div>
                    <div className="text-sm font-medium">启动游戏后关闭启动器</div>
                    <div className="text-xs text-muted-foreground">游戏启动后自动关闭本启动器</div>
                  </div>
                </label>

                <div className="space-y-2">
                  <Label>下载源</Label>
                  <div className="flex flex-wrap gap-2">
                    {DOWNLOAD_SOURCES.map((s) => (
                      <button
                        key={s.value}
                        onClick={() => update('downloadSource', s.value)}
                        className={cn(
                          'rounded-lg border px-4 py-2 text-sm transition-colors',
                          settings.downloadSource === s.value
                            ? 'border-primary bg-primary/10 font-medium text-primary'
                            : 'border-border hover:border-muted-foreground/30'
                        )}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">官方源更新最快，镜像源国内速度较快</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="downloadTimeout">下载超时 (秒)</Label>
                  <Input
                    id="downloadTimeout"
                    type="number"
                    min={5}
                    max={120}
                    value={settings.downloadTimeout}
                    onChange={(e) => update('downloadTimeout', Math.max(0, Math.min(120, parseInt(e.target.value) || 15)))}
                  />
                  <p className="text-xs text-muted-foreground">单个文件下载无响应超过此时间则自动重试（0=不超时，1-120 秒）</p>
                </div>
              </CardContent>
            </Card>
            </div>
          )}

          {category === 'java' && (
            <div key="java" className="animate-in slide-up">
              <Card>
                <CardHeader className="flex-row items-center justify-between">
                  <div>
                    <CardTitle>
                      <FontAwesomeIcon icon={faMicrochip} className="mr-2 h-4 w-4 text-primary" />
                      Java 运行时
                    </CardTitle>
                  </div>
                  <div className="flex items-center gap-3 text-sm">
                    <span className="text-muted-foreground">已检测 <span className="font-medium text-foreground">{runtimes.length}</span></span>
                    <span className="text-muted-foreground">可用 <span className="font-medium text-primary">{validCount}</span></span>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" onClick={() => handleScan('quick')} disabled={scanning !== 'idle'}>
                      <FontAwesomeIcon icon={scanning === 'quick' ? faRotate : faMagnifyingGlass} className={cn('h-4 w-4', scanning === 'quick' && 'animate-spin')} />
                      快速扫描
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => handleScan('deep')} disabled={scanning !== 'idle'}>
                      <FontAwesomeIcon icon={scanning === 'deep' ? faRotate : faBolt} className={cn('h-4 w-4', scanning === 'deep' && 'animate-spin')} />
                      深度扫描
                    </Button>
                    <Button size="sm" variant="outline" onClick={handleManualAdd} disabled={scanning !== 'idle'}>
                      <FontAwesomeIcon icon={faPlus} className="h-4 w-4" />
                      手动添加
                    </Button>
                    <Button size="sm" variant="ghost" asChild>
                      <a href="https://adoptium.net" target="_blank" rel="noreferrer">
                        <FontAwesomeIcon icon={faDownload} className="h-4 w-4" />
                        下载 Java
                      </a>
                    </Button>
                    <Tooltip content="刷新列表">
                      <Button size="sm" variant="ghost" onClick={handleRefresh} disabled={scanning !== 'idle'}>
                        <FontAwesomeIcon icon={faRotate} className={cn('h-4 w-4', scanning !== 'idle' && 'animate-spin')} />
                      </Button>
                    </Tooltip>
                  </div>

                  {scanning !== 'idle' && (
                    <div className="flex items-center gap-3 rounded-lg bg-muted px-4 py-3">
                      <FontAwesomeIcon icon={faRotate} className="h-4 w-4 animate-spin text-primary" />
                      <span className="text-sm text-muted-foreground">正在扫描 Java 运行时...</span>
                    </div>
                  )}

                  {scanning === 'idle' && runtimes.length === 0 && (
                    <div className="flex flex-col items-center gap-4 py-12 text-center">
                      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-muted">
                        <FontAwesomeIcon icon={faMicrochip} className="h-7 w-7 text-muted-foreground" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-foreground">尚未检测到 Java 运行时</p>
                        <p className="mt-1 text-xs text-muted-foreground">点击"快速扫描"自动检测系统中的 Java，或手动添加</p>
                      </div>
                      <Button size="sm" onClick={() => handleScan('quick')}>
                        <FontAwesomeIcon icon={faMagnifyingGlass} className="h-4 w-4" />
                        开始扫描
                      </Button>
                    </div>
                  )}

                  {scanning === 'idle' && runtimes.length > 0 && (
                    <div className="space-y-1">
                      {runtimes.map((j, i) => (
                        <div
                          key={i}
                          className="flex items-center gap-3 rounded-lg border border-border bg-background px-4 py-3 transition-colors hover:border-muted-foreground/30"
                        >
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-sm font-bold text-primary">
                            {j.name.charAt(0)}
                          </div>

                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium">{j.name}</span>
                              <Badge variant="outline" className="h-5 px-1.5 text-[10px]">{j.type}</Badge>
                              {j.state === 'Valid' ? (
                                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">可用</span>
                              ) : (
                                <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive">不可用</span>
                              )}
                            </div>
                            <div className="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground">
                              <span className="flex items-center gap-1">
                                <FontAwesomeIcon icon={faTag} className="h-3 w-3" />
                                版本 {j.version}
                              </span>
                              <span className="flex items-center gap-1">
                                <FontAwesomeIcon icon={faDesktop} className="h-3 w-3" />
                                {j.arch}
                              </span>
                            </div>
                            <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground/60">
                              <FontAwesomeIcon icon={faFolder} className="h-3 w-3 shrink-0" />
                              <span className="truncate">{j.path}</span>
                            </div>
                          </div>

                          <div className="flex shrink-0 items-center gap-0.5">
                            <Tooltip content="打开文件夹">
                              <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => handleOpenFolder(j.path)}>
                                <FontAwesomeIcon icon={faFolderOpen} className="h-3.5 w-3.5" />
                              </Button>
                            </Tooltip>
                            <Tooltip content="删除">
                              <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive/70 hover:text-destructive" onClick={() => handleDelete(j.path)}>
                                <FontAwesomeIcon icon={faTrashCan} className="h-3.5 w-3.5" />
                              </Button>
                            </Tooltip>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-4 py-2.5 text-xs text-muted-foreground">
                    <FontAwesomeIcon icon={faInfoCircle} className="h-3.5 w-3.5 text-primary" />
                    <span>{javaStatus}</span>
                    <span className="ml-auto">
                      {runtimes.length > 0 && `${validCount} / ${runtimes.length} 可用`}
                    </span>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>默认配置</CardTitle>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div className="space-y-2">
                    <Label>默认 Java 运行时</Label>
                    <Select value={settings.defaultJavaPath} onChange={(v) => update('defaultJavaPath', v)}>
                      <SelectOption value="">自动选择</SelectOption>
                      {runtimes.filter((j) => j.state === 'Valid').map((j, i) => (
                        <SelectOption key={i} value={j.path}>{j.name} - {j.version} ({j.arch})</SelectOption>
                      ))}
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      推荐使用自动选择，启动器会为每个游戏版本自动匹配最佳 Java 运行时
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label>内存分配</Label>
                    <div className="flex items-center gap-2">
                      <button onClick={() => {
                        const next = { ...settings, memoryMode: 'auto' as const }
                        if (sysInfo) next.defaultMaxMemory = Math.max(512, Math.floor(sysInfo.availableMemory * 0.7))
                        setSettings(next)
                        saveSettings(next)
                        setSaved(true)
                      }} className={cn('h-9 rounded-lg border px-3.5 text-sm transition-colors', settings.memoryMode === 'auto' ? 'border-primary bg-primary/10 font-medium text-primary' : 'border-border hover:border-muted-foreground/30')}>
                        <FontAwesomeIcon icon={faRobot} className="mr-1.5 h-3.5 w-3.5" />自动
                      </button>
                      <button onClick={() => update('memoryMode', 'custom')} className={cn('h-9 rounded-lg border px-3.5 text-sm transition-colors', settings.memoryMode === 'custom' ? 'border-primary bg-primary/10 font-medium text-primary' : 'border-border hover:border-muted-foreground/30')}>
                        <FontAwesomeIcon icon={faSliders} className="mr-1.5 h-3.5 w-3.5" />自定义
                      </button>
                    </div>

                    {sysInfo ? (
                      <>
                        <div className="flex items-center gap-3 py-1">
                          <input
                            type="range"
                            min={512}
                            max={Math.max(512, Math.floor(sysInfo.availableMemory))}
                            step={256}
                            value={settings.defaultMaxMemory}
                            disabled={settings.memoryMode === 'auto'}
                            onChange={(e) => update('defaultMaxMemory', parseInt(e.target.value))}
                            className={cn('flex-1', settings.memoryMode === 'auto' && 'pointer-events-none opacity-60')}
                          />
                          <span className="w-28 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
                            {settings.defaultMaxMemory >= 1024 ? `${(settings.defaultMaxMemory / 1024).toFixed(1)} GiB` : `${settings.defaultMaxMemory} MiB`}
                          </span>
                        </div>

                        {(() => {
                          const totalMb = sysInfo.memory
                          const availMb = sysInfo.availableMemory
                          const usedMb = Math.max(0, totalMb - availMb)
                          const gameMb = Math.min(settings.defaultMaxMemory, availMb)
                          const totalPx = totalMb
                          const usedPct = (usedMb / totalPx) * 100
                          const gamePct = (gameMb / totalPx) * 100
                          return (
                            <div className="space-y-1">
                              <div className="flex h-2 overflow-hidden rounded-full bg-muted">
                                <div className="rounded-l-full bg-primary/30 transition-all" style={{ width: `${usedPct}%` }} />
                                <div className="bg-primary transition-all" style={{ width: `${gamePct}%` }} />
                              </div>
                              <div className="flex justify-between text-[11px] text-muted-foreground">
                                <span>总内存 {(totalMb / 1024).toFixed(1)} GiB</span>
                                <span>已使用 {(usedMb / 1024).toFixed(1)} GiB</span>
                                <span>游戏分配 {(gameMb / 1024).toFixed(1)} GiB</span>
                                <span>剩余 {((availMb - gameMb) / 1024).toFixed(1)} GiB</span>
                              </div>
                            </div>
                          )
                        })()}
                      </>
                    ) : (
                      <div className="flex items-center gap-3">
                        <input
                          type="range"
                          min={512}
                          max={16384}
                          step={256}
                          value={settings.defaultMaxMemory}
                          disabled={settings.memoryMode === 'auto'}
                          onChange={(e) => update('defaultMaxMemory', parseInt(e.target.value))}
                          className={cn('flex-1', settings.memoryMode === 'auto' && 'pointer-events-none opacity-60')}
                        />
                        <span className="w-28 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
                          {settings.defaultMaxMemory >= 1024 ? `${(settings.defaultMaxMemory / 1024).toFixed(1)} GiB` : `${settings.defaultMaxMemory} MiB`}
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="jvmArgs">额外 JVM 参数</Label>
                    <Input id="jvmArgs" value={settings.jvmArgs} onChange={(e) => update('jvmArgs', e.target.value)} placeholder="-XX:+UseG1GC -Dfml.ignoreInvalidMinecraftCertificates=true" />
                    <p className="text-xs text-muted-foreground">启动 Minecraft 时附加的 JVM 参数</p>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {category === 'appearance' && (
            <div key="appearance" className="animate-in slide-up">
            <Card>
              <CardHeader>
                <CardTitle>
                  <FontAwesomeIcon icon={faPalette} className="mr-2 h-4 w-4 text-primary" />
                  显示设置
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="space-y-2">
                  <Label>界面语言</Label>
                  <Select value={settings.language} onChange={(v) => update('language', v)}>
                    <SelectOption value="zh-CN">简体中文</SelectOption>
                    <SelectOption value="en">English</SelectOption>
                  </Select>
                </div>

                <div className="space-y-3">
                  <Label>动画</Label>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <Checkbox
                      checked={settings.animationsEnabled}
                      onCheckedChange={(c) => update('animationsEnabled', c === true)}
                    />
                    <div>
                      <div className="text-sm font-medium">启用页面动画</div>
                      <div className="text-xs text-muted-foreground">开启后页面切换、弹窗等带有过渡动画效果</div>
                    </div>
                  </label>

                  {settings.animationsEnabled && (
                    <div className="space-y-2 pl-7">
                      <Label>动画速度</Label>
                      <div className="flex items-center gap-3">
                        <input
                          type="range"
                          min={0.25}
                          max={2}
                          step={0.25}
                          value={settings.animationSpeed}
                          onChange={(e) => update('animationSpeed', parseFloat(e.target.value))}
                          className="flex-1"
                        />
                        <span className="w-14 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
                          {settings.animationSpeed}x
                        </span>
                      </div>
                      <div className="flex justify-between text-[11px] text-muted-foreground">
                        <span>慢</span>
                        <span>正常</span>
                        <span>快</span>
                      </div>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
            </div>
          )}

          {category === 'roomcode' && (
            <div key="roomcode" className="animate-in slide-up">
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>
                    <FontAwesomeIcon icon={faKey} className="mr-2 h-4 w-4 text-primary" />
                    生成房间码
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <Button onClick={handleGenerate}>
                    <FontAwesomeIcon icon={faSliders} className="h-4 w-4" />
                    生成房间码
                  </Button>
                  {roomCode && (
                    <div className="rounded-lg border bg-background p-5 text-center">
                      <code className="text-3xl font-bold tracking-[6px] text-primary">{roomCode}</code>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>
                    <FontAwesomeIcon icon={faKey} className="mr-2 h-4 w-4" />
                    验证房间码
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="code">输入房间码</Label>
                    <Input
                      id="code"
                      value={validationCode}
                      onChange={(e) => setValidationCode(e.target.value)}
                      placeholder="输入房间码"
                    />
                  </div>
                  <Button variant="secondary" onClick={handleValidate}>
                    验证
                  </Button>
                  {validationResult !== null && (
                    <p className={`text-sm ${validationResult ? 'text-primary' : 'text-destructive'}`}>
                      <FontAwesomeIcon icon={validationResult ? faCheck : faXmark} className="mr-1 h-3 w-3" />
                      {validationResult ? '有效' : '无效'}
                    </p>
                  )}
                </CardContent>
              </Card>
            </div>
            </div>
          )}

          {category === 'about' && (
            <div key="about" className="animate-in slide-up">
            <Card>
              <CardHeader>
                <CardTitle>
                  <FontAwesomeIcon icon={faInfoCircle} className="mr-2 h-4 w-4 text-primary" />
                  关于 Qomicex Launcher
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center gap-4">
                  <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary font-bold text-2xl text-primary-foreground shadow-lg shadow-primary/30">
                    Q
                  </div>
                  <div>
                    <div className="text-lg font-semibold">Qomicex Launcher</div>
                    <div className="text-sm text-muted-foreground">版本 0.1.0</div>
                  </div>
                </div>

                <p className="text-sm leading-relaxed text-muted-foreground">
                  一个现代化的 Minecraft 启动器，支持多版本管理、模组加载器兼容、账户管理等功能。
                </p>

                <div className="rounded-lg bg-background p-4 text-sm">
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      ['技术栈', 'ASP.NET Core + React + Tauri'],
                      ['前端', `React ${React.version}`],
                      ['协议', 'MIT License'],
                    ].map(([label, value]) => (
                      <div key={label}>
                        <div className="text-xs text-muted-foreground">{label}</div>
                        <div className="mt-0.5 font-medium text-sm">{value}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
            </div>
          )}

          {saved && (
            <div className="fixed bottom-6 right-6 flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-lg">
              <FontAwesomeIcon icon={faCheck} className="h-4 w-4" />
              设置已保存
            </div>
          )}

          <Dialog open={addDialogOpen} onClose={() => setAddDialogOpen(false)}>
            <DialogHeader onClose={() => setAddDialogOpen(false)}>
              <DialogTitle>手动添加 Java</DialogTitle>
            </DialogHeader>
            <DialogBody className="space-y-3">
              <div className="space-y-1.5">
                <Label>Java 可执行文件路径</Label>
                <div className="flex gap-2">
                  <Input value={addPath} onChange={(e) => setAddPath(e.target.value)} placeholder="C:\Program Files\Java\jdk-17\bin\java.exe" className="flex-1" />
                  <Button variant="outline" onClick={handleBrowseJava}>浏览</Button>
                </div>
                <p className="text-xs text-muted-foreground">选择或输入 java.exe 的完整路径</p>
              </div>
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setAddDialogOpen(false)}>取消</Button>
              <Button onClick={confirmAddJava} disabled={!addPath || adding}>
                {adding ? '验证中...' : '添加'}
              </Button>
            </DialogFooter>
          </Dialog>
        </div>
      </div>
    </div>
  )
}
