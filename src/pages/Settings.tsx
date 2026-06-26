import React, { useState, useEffect, useCallback } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faRocket, faMicrochip, faPalette, faInfoCircle, faKey, faFolderOpen, faSliders, faCheck, faXmark, faMagnifyingGlass, faBolt, faPlus, faDownload, faRotate, faCircle, faFolder, faTrashCan } from '@fortawesome/free-solid-svg-icons'
import { Button } from '../components/ui/button.tsx'
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card.tsx'
import { Input } from '../components/ui/input.tsx'
import { Label } from '../components/ui/label.tsx'
import { Badge } from '../components/ui/badge.tsx'
import { Select, SelectOption } from '../components/ui/select.tsx'
import { Tooltip } from '../components/ui/tooltip.tsx'
import { useMessageBox } from '../components/ui/message-box.tsx'
import { cn } from '../lib/utils.ts'
import { generateRoomCode, validateRoomCode } from '../api/roomCode.ts'
import { searchJava, validateJavaPath } from '../api/java.ts'
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
  defaultMaxMemory: number
  jvmArgs: string
  language: string
  defaultJavaPath: string
  downloadSource: number
  downloadTimeout: number
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
  defaultMaxMemory: 4096,
  jvmArgs: '',
  language: 'zh-CN',
  defaultJavaPath: '',
  downloadSource: 0,
  downloadTimeout: 15,
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
}

export default function Settings() {
  const { error: msgError, prompt: msgPrompt, success: msgSuccess } = useMessageBox()
  const [category, setCategory] = useState('launcher')
  const [settings, setSettings] = useState<AppSettings>(loadSettings)
  const [saved, setSaved] = useState(false)

  const [runtimes, setRuntimes] = useState<JavaRuntime[]>([])
  const [scanning, setScanning] = useState<'idle' | 'quick' | 'deep'>('idle')

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

  const handleScan = useCallback(async (mode: 'quick' | 'deep') => {
    setScanning(mode)
    try {
      const result = await searchJava()
      setRuntimes(result)
    } catch (e) {
      console.error(e)
    } finally {
      setScanning('idle')
    }
  }, [])

  function handleOpenFolder(path: string) {
    const dir = path.replace(/[/\\]java(\.exe)?$/i, '')
    import('@tauri-apps/plugin-opener').then(({ openUrl }) => openUrl(dir)).catch(() => {})
  }

  async function handleManualAdd() {
    const p = await msgPrompt('请输入 Java 可执行文件的完整路径（如 C:\\Program Files\\Java\\jdk-17\\bin\\java.exe）', '手动添加 Java')
    if (!p) return
    try {
      const result = await validateJavaPath(p)
      setRuntimes((prev) => {
        const exists = prev.some((j) => j.path === result.path)
        return exists ? prev : [...prev, result]
      })
      msgSuccess(`已添加 Java: ${result.name} ${result.version}`)
    } catch {
      msgError('无法识别该路径下的 Java 运行时')
    }
  }

  function handleDelete(path: string) {
    setRuntimes((prev) => prev.filter((j) => j.path !== path))
    if (settings.defaultJavaPath === path) {
      update('defaultJavaPath', '')
    }
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
    <div className="animate-in p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">设置</h1>
      </div>

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
                  <input
                    type="checkbox"
                    checked={settings.versionIsolation}
                    onChange={(e) => update('versionIsolation', e.target.checked)}
                    className="h-4 w-4 rounded border-border bg-background accent-primary"
                  />
                  <div>
                    <div className="text-sm font-medium">版本隔离</div>
                    <div className="text-xs text-muted-foreground">每个版本使用独立的 mods/config/saves 目录，推荐保持开启</div>
                  </div>
                </label>

                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.closeAfterLaunch}
                    onChange={(e) => update('closeAfterLaunch', e.target.checked)}
                    className="h-4 w-4 rounded border-border bg-background accent-primary"
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
                  <p className="text-xs text-muted-foreground">官方源需要国际网络访问，BMCLAPI 镜像国内可用</p>
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
          )}

          {category === 'java' && (
            <>
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
                  </div>

                  {scanning !== 'idle' && (
                    <p className="text-sm text-muted-foreground">正在扫描 Java 运行时...</p>
                  )}

                  {scanning === 'idle' && runtimes.length === 0 && (
                    <div className="flex flex-col items-center gap-2 py-8 text-center text-muted-foreground">
                      <FontAwesomeIcon icon={faMicrochip} className="h-8 w-8 opacity-30" />
                      <p className="text-sm">尚未扫描 Java 运行时，点击"快速扫描"开始检测</p>
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
                            </div>
                            <div className="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground">
                              <span>版本 {j.version}</span>
                              <span>{j.arch}</span>
                              <FontAwesomeIcon icon={faCircle} className={cn('h-1.5 w-1.5', j.state === 'Valid' ? 'text-primary' : 'text-muted-foreground')} />
                              <span className={j.state === 'Valid' ? 'text-primary' : 'text-muted-foreground'}>
                                {j.state === 'Valid' ? '可用' : '不可用'}
                              </span>
                            </div>
                            <div className="mt-0.5 truncate text-xs text-muted-foreground/60">{j.path}</div>
                          </div>

                          <div className="flex shrink-0 items-center gap-0.5">
                            <Tooltip content="打开文件夹">
                              <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => handleOpenFolder(j.path)}>
                                <FontAwesomeIcon icon={faFolder} className="h-3.5 w-3.5" />
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
                    <Label htmlFor="maxMemory">默认最大内存 (MB)</Label>
                    <Input
                      id="maxMemory"
                      type="number"
                      min={512}
                      max={65536}
                      step={512}
                      value={settings.defaultMaxMemory}
                      onChange={(e) => update('defaultMaxMemory', Math.max(512, parseInt(e.target.value) || 512))}
                    />
                    <p className="text-xs text-muted-foreground">新建实例时的默认内存分配</p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="jvmArgs">额外 JVM 参数</Label>
                    <Input id="jvmArgs" value={settings.jvmArgs} onChange={(e) => update('jvmArgs', e.target.value)} placeholder="-XX:+UseG1GC -Dfml.ignoreInvalidMinecraftCertificates=true" />
                    <p className="text-xs text-muted-foreground">启动 Minecraft 时附加的 JVM 参数</p>
                  </div>
                </CardContent>
              </Card>
            </>
          )}

          {category === 'appearance' && (
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

                <p className="text-sm text-muted-foreground">更多外观选项即将推出</p>
              </CardContent>
            </Card>
          )}

          {category === 'roomcode' && (
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
          )}

          {category === 'about' && (
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
          )}

          {saved && (
            <div className="fixed bottom-6 right-6 flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-lg">
              <FontAwesomeIcon icon={faCheck} className="h-4 w-4" />
              设置已保存
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
