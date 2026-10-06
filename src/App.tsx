import { useEffect, useState, useRef } from 'react'
import type { ReactNode } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout.tsx'
import Dashboard from './pages/Dashboard.tsx'
import Instances from './pages/Instances.tsx'
import InstanceDetailPage from './pages/InstanceDetail.tsx'
import DownloadCenter from './pages/DownloadCenter.tsx'
import Accounts from './pages/Accounts.tsx'
import AccountDetail from './pages/AccountDetail.tsx'
import ResourceCenter from './pages/ResourceCenter.tsx'
import ResourceDetailPage from './pages/ResourceDetail.tsx'
import Connect from './pages/Connect.tsx'
import Settings from './pages/Settings.tsx'
import RunningInstances from './pages/RunningInstances.tsx'
import PluginPage from './pages/PluginPage.tsx'
import PluginWebviewPage from './pages/PluginWebviewPage.tsx'
import LogAnalysis from './pages/LogAnalysis.tsx'
import GameLogWindow from './pages/GameLogWindow.tsx'
import PluginOverlayManager from './components/PluginOverlayManager.tsx'
import DeepLinkHandler from './components/DeepLinkHandler.tsx'
import { MessageBoxProvider, useMessageBox } from './components/ui'
import TaskCompletionNotifier from './components/TaskCompletionNotifier.tsx'
import useCloseGuard from './hooks/useCloseGuard.ts'
import ErrorBoundary from './components/ErrorBoundary.tsx'
import { loadSettings, onSettingsChange, getSettings, isSettingsLoaded, DEFAULT_SETTINGS, type AppSettings } from './api/settings.ts'
import { reportFrontendLog } from './api/logs.ts'
import { pushConsole } from './lib/error-report.ts'
import { I18nProvider, useI18n } from './i18n/index.tsx'
import { RunningProvider, useRunning } from './contexts/RunningContext.tsx'
import LaunchProgressDialog from './components/LaunchProgressDialog.tsx'
import { CrashAnalysisDialog } from './components/CrashAnalysisDialog.tsx'
import UpdateDialog from './components/UpdateDialog.tsx'
import UpdateCompleteDialog from './components/UpdateCompleteDialog.tsx'
import UpdateReadyToast from './components/UpdateReadyToast.tsx'
import { get } from './api/client.ts'
import { initApiTransport, isIpcMode } from './api/ipc.ts'
import { fetchUpdatePlan, fetchAutoInstallState, clearPendingInstall as clearPendingInstallFromApi, takeUpdateNotice, takeUpdateError, type UpdatePlan, type UpdateNotice, type UpdateError } from './api/update.ts'
import { resolveChannel, stagedChannelMatchesCurrent } from './lib/updateChannel.ts'
import { APP_INFO } from './constants/credits.ts'
import { applyThemeColor } from './lib/themeColor.ts'
import { restoreSavedTheme } from './theme/index.ts'

import { loadCustomRuntimes, scanRuntimes, getRuntimes, hasAnyRuntimes } from './stores/javaStore.ts'
import { SplashScreen } from './components/SplashScreen.tsx'
import { InitialSetupWizard } from './components/InitialSetupWizard.tsx'
import { usePluginStore, collectInstalledPlugins, buildUpdatesMap } from './stores/pluginStore.ts'
import { useUpdaterStore } from './stores/updaterStore.ts'
import { activatePlugin, deactivatePlugin, sortByDependencies } from './plugins/plugin-loader.tsx'
import { checkStoreUpdates } from './api/pluginStore.ts'
import './plugins/plugin-registry.ts'
import type { PluginState } from './plugins/types.ts'

/** 独立日志窗口模式：`?logWindow=1&instance=<id>`（由「测试游戏」打开的 Tauri 子窗口）。 */
const LOG_WINDOW_INSTANCE: string | null =
  typeof window !== 'undefined'
    ? (() => {
        const p = new URLSearchParams(window.location.search)
        return p.get('logWindow') === '1' ? p.get('instance') || '' : null
      })()
    : null

/** l4 插件独立窗口模式：`?pluginWebview=1&pluginId=<id>`（由 createRemoteWebview 打开）。 */
const PLUGIN_WEBVIEW_PLUGIN_ID: string | null =
  typeof window !== 'undefined'
    ? (() => {
        const p = new URLSearchParams(window.location.search)
        return p.get('pluginWebview') === '1' ? p.get('pluginId') || '' : null
      })()
    : null

function OverlayStoreBridge() {
  const { createOverlay, showOverlay, hideOverlay, destroyOverlay, setOverlayHtml, setOverlayPosition, setOverlaySize } = usePluginStore()
  useEffect(() => {
    (window as any).__pluginOverlayStore = { createOverlay, showOverlay, hideOverlay, destroyOverlay, setOverlayHtml, setOverlayPosition, setOverlaySize }
  }, [createOverlay, showOverlay, hideOverlay, destroyOverlay, setOverlayHtml, setOverlayPosition, setOverlaySize])
  return null
}

function RunningNotifyBridge() {
  const { notify } = useMessageBox()
  const { setNotifyImpl } = useRunning()
  useEffect(() => { setNotifyImpl(notify) }, [notify, setNotifyImpl])
  return null
}

/**
 * 判断本次发现的更新是否走「自动下载 + Toast」路径。
 *
 * 返回 `null` = 回落到原有更新对话框，原因可能是：
 * - 用户关掉了「自动下载并安装更新」开关（`updateAutoInstall === false`）；
 * - `required` 强制更新——它的语义是"必须更新后才能继续使用"，静默下载 + 一个
 *   可关闭的 Toast 会弱化这一点，且用户可能一直不点导致永远卡在旧版；
 * - `channelSwitch` 跨通道切换——用户需要明确知晓自己在换发布列车（ADR-081），
 *   悄悄装完等于绕过了这个知情前提；
 * - 该版本此前自动安装失败已超重试上限（壳侧记的 abandonedVersion）——再自动
 *   下载只会重复失败，交回弹窗让用户主动决定；
 * - 已有下载完成、待安装的记录（`staged`）——不重复下载几十 MB。
 *
 * 任何一次查询失败都返回 `null`（回落到弹窗）：自动路径是附加体验，读不到状态时
 * 宁可按原有行为走，也不要出现"既没弹窗也没提示"的黑洞。
 */
async function resolveAutoInstallPlan(
  plan: UpdatePlan,
  required: boolean,
): Promise<UpdatePlan | null> {
  if (required || plan.channelSwitch) return null
  if (getSettings().updateAutoInstall === false) return null
  if (useUpdaterStore.getState().staged) return null
  const dataDir = (getSettings().dataDir || '').replace(/[\\/]+$/, '')
  if (!dataDir) return null
  try {
    const state = await fetchAutoInstallState(dataDir)
    // 该版本已因重试超限作废：不再自动下载，回退弹窗
    if (state.abandonedVersion && state.abandonedVersion === plan.version) return null
    if (state.hasPending) return null
    return plan
  } catch (e) {
    console.warn('[updater] auto install state check failed:', e)
    return null
  }
}

function AppContent() {
  const [backendState, setBackendState] = useState<'loading' | 'ready' | 'error'>('loading')
  const { closeWithGuard, Provider } = useCloseGuard()
  const { alert } = useMessageBox()
  const { t } = useI18n()
  const { crashDialogState, clearCrashDialog } = useRunning()
  /** 正在运行的实例：自动安装前据此推迟，避免把用户正在玩的游戏连启动器一起关掉 */
  const { runningInstances } = useRunning()
  const javaChecked = useRef(false)
  const [pendingUpdate, setPendingUpdate] = useState<UpdatePlan | null>(null)
  const [pendingUpdateRequired, setPendingUpdateRequired] = useState(false)
  const updateNoticeChecked = useRef(false)
  /** 启动时的自动安装只判定一次（与 autoCheckDone/javaChecked 同模式） */
  const autoInstallChecked = useRef(false)
  /**
   * 运行中实例数的最新值。自动安装判定跑在一次性的 setTimeout 里（不随
   * runningInstances 重排），用 ref 读取避免闭包拿到过期的空数组而误判「没在跑」。
   */
  const runningCountRef = useRef(0)
  runningCountRef.current = runningInstances.length
  /** 「更新完成」交接提示（自更新重启后的首次启动，只弹一次，见 UpdateCompleteDialog） */
  const [updateNotice, setUpdateNotice] = useState<UpdateNotice | null>(null)
  /** 「更新未完成」交接提示（updater 失败后由新进程读出并解释原因，只弹一次） */
  const [updateError, setUpdateError] = useState<UpdateError | null>(null)
  const autoCheckDone = useRef(false)
  /** 插件更新静默轮询只做一次（与 autoCheckDone/javaChecked 同模式） */
  const pluginUpdatesChecked = useRef(false)
  const { loadPlugins } = usePluginStore()
  /**
   * 「有可用更新」的会话级事实源（#147）：后台检查发现新版本时写入，
   * 设置页「更新」区域据此常驻提示。`available == null` 表示尚未探知或无更新。
   */
  const setUpdateAvailable = useUpdaterStore((s) => s.setAvailable)
  const [showWizard, setShowWizard] = useState(false)
  const [settingsReady, setSettingsReady] = useState(false)
  const [wizardSettings, setWizardSettings] = useState<AppSettings>({ ...DEFAULT_SETTINGS })

  useEffect(() => {
    let cancelled = false
    let attempts = 0
    const poll = async () => {
      while (!cancelled && attempts < 10) {
        // 每轮重试 IPC 端到端探测（非 Tauri 环境立即返回；已解析则跳过）。
        // release 下后端解压/spawn 可能晚于首帧，一次性探测会永久锁错传输。
        await initApiTransport()
        try {
          // 用轻量 /health（不触外部网络 ping），避免就绪判定被慢速诊断端点阻塞
          await get('/health')
          if (!cancelled) setBackendState('ready')
          return
        } catch { attempts++ }
        if (!cancelled) await new Promise(r => setTimeout(r, 1000))
      }
      if (!cancelled && !isIpcMode()) {
        console.error(
          '[app] backend unreachable after 10 attempts (transport=http :5000)。' +
          'release 应走 qomicex:// 管道；dev 需手动启动 src-backend/qomicex-backend（cargo run）。',
        )
      }
      if (!cancelled) setBackendState('error')
    }
    poll()
    return () => { cancelled = true }
  }, [])

  // /health 通过（backend 已监听）后再拉取设置：挂载即拉会输给 release 冷启动的
  // 解压+spawn 时序，失败曾把默认值当成真实设置误触初始化向导。
  useEffect(() => {
    if (backendState !== 'ready') return
    void loadSettings()
  }, [backendState])

  useEffect(() => {
    if (backendState !== 'ready') return
    const onSettings = (s: AppSettings) => {
      setSettingsReady(true)
      if (s.initialized !== true) {
        setWizardSettings(s)
        setShowWizard(true)
      }
    }
    // settings 可能在挂载前已加载完成
    if (isSettingsLoaded()) onSettings(getSettings())
    const unsub = onSettingsChange(onSettings)
    return unsub
  }, [backendState])

  useEffect(() => {
    if (backendState !== 'ready' || !settingsReady || javaChecked.current || showWizard) return
    javaChecked.current = true
    ;(async () => {
      try {
        await loadCustomRuntimes()
        if (!hasAnyRuntimes()) await scanRuntimes('quick')
        if (!getRuntimes().some(r => r.state === 'Valid')) {
          alert(t('common.javaRuntimeRequired'), t('common.javaRuntimeRequiredTitle'))
        }
      } catch (e) {
        // 引导失败时下面那句「缺少 Java」 alert 不会出现，用户卡在向导前；
        // 这里用 console 而非 alert——引导期连弹两个对话框会把窗口挡死。
        console.error('Java 运行时引导失败：', e)
      }
    })()
  }, [backendState, settingsReady, showWizard, alert])

  useEffect(() => {
    if (backendState !== 'ready' || autoCheckDone.current) return
    const timer = setTimeout(async () => {
      try {
        // 通道裁决：用户显式选择 > 已安装构建所属列车。undefined = 开发构建
        // （裸 X.Y.Z）或无法识别的版本 → 不检查更新。
        // 旧逻辑是 `|| 'stable'`，把 beta/alpha/开发构建全按稳定通道请求。
        const channel = resolveChannel(APP_INFO.version)
        if (!channel) return

        const plan = await fetchUpdatePlan(channel)
        if (!plan.hasUpdate || !plan.version) return

        // required 由上游随 plan 一并给出，无需再打一次 /update/check。
        const required = plan.required === true

        // #147：先记「有可用更新」，再做 24h 延迟裁决。设置页的提示反映「确实存在
        // 新版本」这一客观事实，与弹窗的 snooze（别再弹窗烦我）是两回事——用户点了
        // 「下次再说」后仍应在设置页看到提示，避免"有新版本却哪都不说"。
        setUpdateAvailable(plan)

        // 自动模式：普通更新 → 后台静默下载，完成后弹可点击的 Toast；
        // 强制更新与跨通道切换仍走原对话框（见下面 resolveAutoInstallPlan 的注释）。
        const autoPlan = await resolveAutoInstallPlan(plan, required)
        if (autoPlan) {
          void useUpdaterStore.getState().autoStart(autoPlan)
          return
        }

        // 该版本已下载完成、正等着安装（Toast 已在显示）→ 不再弹对话框。
        // 两条提示同时出现会让人以为要装两遍，且对话框的「立即更新」会走一遍
        // 多余的下载前置检查。
        //
        // 例外：phase === 'error' —— 已尝试安装但没成功（例如 updater 没起来）。
        // 此时必须把对话框放出来作为**可见的失败出口**：Toast 在 error 下已隐藏，
        // 否则用户只看到提示消失、没有任何重试入口。对话框的「立即更新」会经
        // store.start 收敛到已下载的那个包（不重复下载）。
        const current = useUpdaterStore.getState()
        if (current.staged && current.staged.version === plan.version && current.phase !== 'error') return

        // snooze 键带通道：同版本号在不同通道下是不同目标，不能互相抵消。
        const snooze = localStorage.getItem('snooze-update')
        if (!required && snooze) {
          try {
            const s = JSON.parse(snooze)
            if (s.key === `${channel}:${plan.version}` && s.until > Date.now()) return
          } catch {
            // localStorage 里的 snooze 值是本地写入的，损坏/被改格式时按「未延迟」处理即可，
            // 静默回退是正确语义，这里仅说明为何可以不处理。
          }
        }

        setPendingUpdate(plan)
        setPendingUpdateRequired(required)
      } catch (e) {
        console.warn('[updater] background check failed:', e)
      }
    }, 5000)
    return () => clearTimeout(timer)
    // `resolveAutoInstallPlan` 是模块级纯函数（依赖经 getSettings/getState 现取），
    // 不进依赖数组——放进去只会让 effect 在每次渲染重排 timer。
  }, [backendState, setUpdateAvailable])

  // 自动安装：启动时若磁盘上已有「下载完成、待安装」的记录，
  // 直接装完——这正是「Toast 不点击，下次打开还是会自动安装完」的落点。
  //
  // 有实例正在运行时**推迟**：此时安装会 restart 启动器，等于把用户正在玩的游戏
  // 连同启动器一起关掉。推迟是安全的——记录留在磁盘上，下次启动再消费；
  // 同时把记录恢复成 Toast，让用户在本会话里也能主动安装。
  useEffect(() => {
    if (backendState !== 'ready' || !settingsReady || autoInstallChecked.current) return
    const timer = setTimeout(async () => {
      autoInstallChecked.current = true
      const dataDir = (getSettings().dataDir || '').replace(/[\\/]+$/, '')
      if (!dataDir) return
      // 开关关闭时不碰记录：用户明确要求手动更新（记录也已由设置页在关闭时清掉）。
      if (getSettings().updateAutoInstall === false) return

      if (runningCountRef.current > 0) {
        // 推迟到下次启动；但要把已下好的包在本次会话里恢复成可点击的 Toast，
        // 否则它完全不可见，用户既不知道已就绪也无法现在装。
        try {
          const state = await fetchAutoInstallState(dataDir)
          if (state.pending) {
            // 跨列车守卫（ADR-081）：用户中途切了通道时，这份包已不属于当前列车，
            // 不能给它一个"点这里安装"的入口（否则等于绕过通道切换的显式前提）。
            // 与 installStagedOnLaunch 用同一个判定函数，两条路径结论必须一致。
            if (stagedChannelMatchesCurrent(state.pending.channel, APP_INFO.version)) {
              useUpdaterStore.getState().restoreStaged(state.pending)
              console.warn('[updater] 有实例运行中，推迟自动安装到下次启动')
            } else {
              console.warn('[updater] 暂存包属于别的通道，不提供自动安装入口')
              void clearPendingInstallFromApi(dataDir)
            }
            return
          }
        } catch (e) {
          console.warn('[updater] restore staged state failed:', e)
        }
        return
      }
      void useUpdaterStore.getState().installStagedOnLaunch()
    }, 2000)
    return () => clearTimeout(timer)
  }, [backendState, settingsReady])

  // 更新完成交接（#108）：自更新重启后的首次启动读取旧进程留下的交接文件，
  // 弹「更新完成」对话框展示新版本与 changelog。读后即删，只提示一次；
  // 版本不一致（updater 装失败、用户手动开旧版）时静默丢弃，不误报。
  useEffect(() => {
    if (backendState !== 'ready' || !settingsReady || updateNoticeChecked.current) return
    // 守卫标志放在 timer 回调里置位，而不是 effect body：main.tsx 包了
    // StrictMode，effect body 置位 + cleanup 清 timer 会让第二次挂载因标志
    // 已 true 而不再排 timer，导致交接永远读不到（StrictMode 双调用独有的坑）。
    // 放回调里后，StrictMode 的清理只取消未触发的 timer，重挂载会重新排一个。
    const timer = setTimeout(async () => {
      updateNoticeChecked.current = true
      const dataDir = (getSettings().dataDir || '').replace(/[\\/]+$/, '')
      let noticeShown = false
      const notice = await takeUpdateNotice(dataDir)
      if (notice) {
        // 版本守卫：交接文件里的目标版本必须与当前运行版本一致（忽略 v 前缀与
        // 首尾空白）。不一致说明更新实际没落地（updater 失败/手动开旧构建），
        // 此时弹「更新完成」是错误信息，直接丢弃（文件已在 Rust 侧消费）。
        const norm = (v: string) => (v || '').trim().replace(/^v+/i, '')
        if (norm(notice.version) === norm(APP_INFO.version)) {
          setUpdateNotice(notice)
          noticeShown = true
        }
      }
      // 「更新未完成」交接（issue #201）：updater 没装成时旧进程早已退出，而它是
      // detached 的——屏幕上原本不会留下任何痕迹，用户只看到「应用自己消失了」。
      // 这里**不套**上面那个版本守卫：失败讲的正是「版本没前进」，守卫会把它自己
      // 过滤掉；只在「更新完成」已要展示时让位（同一次启动不叠两个弹窗）。
      const failure = await takeUpdateError(dataDir)
      if (failure && !noticeShown) setUpdateError(failure)
    }, 1500)
    return () => clearTimeout(timer)
  }, [backendState, settingsReady])

  useEffect(() => {
    if (backendState !== 'ready') return
    loadPlugins().then(() => {
      const { plugins: loaded } = usePluginStore.getState()
      const ordered = sortByDependencies(loaded)
      for (const p of ordered) {
        if (p.state === 'active') {
          activatePlugin(p)
        } else if (p.state === 'installed') {
          if (p.manifest.layers.every(l => l === 'l3')) continue
          activatePlugin(p)
        }
      }
      // 插件更新静默轮询：一次性、异步不阻塞、失败零影响（不发 toast，仅存全局供管理 tab badge 显示）
      if (pluginUpdatesChecked.current) return
      pluginUpdatesChecked.current = true
      checkStoreUpdates(collectInstalledPlugins(loaded))
        .then((res) => {
          const map = buildUpdatesMap(res.updates ?? [], loaded)
          if (Object.keys(map).length > 0) usePluginStore.getState().setUpdates(map)
        })
        .catch((e) => console.warn('[plugins] silent update check failed:', e))
    })
  }, [backendState, loadPlugins])

  useEffect(() => {
    const onPluginStateChange = async (event: Event) => {
      const { id, state } = (event as CustomEvent<{ id: string; state: PluginState }>).detail
      let plugin = usePluginStore.getState().getPlugin(id)
      if (!plugin) {
        await loadPlugins()
        plugin = usePluginStore.getState().getPlugin(id)
      }
      if (!plugin) return
      if (state === 'active') void activatePlugin({ ...plugin, state: 'active' })
      if (state === 'disabled') deactivatePlugin(id)
    }
    window.addEventListener('plugin:state-change', onPluginStateChange)
    return () => window.removeEventListener('plugin:state-change', onPluginStateChange)
  }, [loadPlugins])

  return (
    <Provider value={closeWithGuard}>
      <BrowserRouter>
        <RunningNotifyBridge />
        <TaskCompletionNotifier />
        {/* 外部唤起（qomicex-launcher:// 深链，issue #127）：须在 Router 内（用 navigate）
            且在 RunningProvider 内（用 launchInstance）。冷启动链接要等后端就绪**且设置已加载**
            再消费——只看后端会让整合包安装读到默认 gameDir 而装错目录。 */}
        <DeepLinkHandler
          backendReady={backendState === 'ready'}
          settingsReady={settingsReady}
          blocked={showWizard || !settingsReady}
        />
        <ErrorBoundary>
          <Routes>
            <Route element={<Layout />}>
              {backendState === 'ready' ? (
                <>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/instances" element={<Instances />} />
                  <Route path="/instances/:id" element={<InstanceDetailPage />} />
                  <Route path="/downloads" element={<DownloadCenter />} />
                  <Route path="/accounts" element={<Accounts />} />
                  <Route path="/accounts/:uuid" element={<AccountDetail />} />
                  <Route path="/resource-center" element={<ResourceCenter />} />
                  <Route path="/resource-center/:resourceId" element={<ResourceDetailPage />} />
                  <Route path="/connect" element={<Connect />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="/running" element={<RunningInstances />} />
                  <Route path="/log-analysis" element={<LogAnalysis />} />
                  <Route path="/plugins/p/:pluginId" element={<PluginPage />} />
                </>
              ) : (
                <Route path="*" element={<div />} />
              )}
            </Route>
          </Routes>
        </ErrorBoundary>
      </BrowserRouter>
      <SplashScreen state={backendState} onRetry={() => window.location.reload()} />
      <InitialSetupWizard
        open={showWizard && backendState === 'ready'}
        settings={wizardSettings}
        onComplete={() => setShowWizard(false)}
      />
      <LaunchProgressDialog />
      <OverlayStoreBridge />
      <PluginOverlayManager />
      <CrashAnalysisDialog
        open={!!crashDialogState}
        title={crashDialogState?.title || ''}
        message={crashDialogState?.message || ''}
        detail={crashDialogState?.detail}
        args={crashDialogState?.args}
        crashReport={crashDialogState?.crashReport}
        analysis={crashDialogState?.analysis}
        analysisLoading={crashDialogState?.loading}
        error={crashDialogState?.error}
        mcloGsUrl={crashDialogState?.mcloGsUrl}
        qrCodeBase64={crashDialogState?.qrCodeBase64}
        instanceId={crashDialogState?.instanceId}
        onClose={clearCrashDialog}
      />
      <UpdateDialog
        open={pendingUpdate !== null}
        plan={pendingUpdate}
        required={pendingUpdateRequired}
        onClose={() => {
          if (pendingUpdate && !pendingUpdateRequired) {
            localStorage.setItem('snooze-update', JSON.stringify({ key: `${pendingUpdate.channel ?? 'release'}:${pendingUpdate.version}`, until: Date.now() + 86400000 }))
          }
          setPendingUpdate(null)
          setPendingUpdateRequired(false)
        }}
      />
      <UpdateCompleteDialog
        open={updateNotice !== null || updateError !== null}
        notice={updateNotice}
        error={updateError}
        onClose={() => {
          setUpdateNotice(null)
          setUpdateError(null)
        }}
      />
      {/* 自动更新「已准备好安装」Toast：下载完成后弹，点击立即重启
          安装，不点击则下次启动由 installStagedOnLaunch 自动装完。 */}
      <UpdateReadyToast />
    </Provider>
  )
}

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const

const _console = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
  trace: console.trace.bind(console),
}

function setConsoleLevel(level: string) {
  const idx = LOG_LEVELS.indexOf(level as typeof LOG_LEVELS[number])
  if (idx < 0) return
  // LOG_LEVELS 由低到高：trace(0) debug(1) info(2) warn(3) error(4)。
  // tracing 语义：EnvFilter "info" 显示 >= info 级别（info/warn/error），
  // 设置级别越高显示越少。shouldLog(lvlIdx) = lvlIdx >= idx。
  const shouldLog = (lvlIdx: number) => lvlIdx >= idx

  // 包装 console 方法：按 logLevel 决定是否显示，同时上报后端日志体系
  // （构建版 Tauri 无控制台，前端日志靠 POST /logs/frontend 落盘可查），
  // 并填充前端环形缓冲（严重错误上报时作为上下文附带）。
  function wrap(method: 'log' | 'warn' | 'error' | 'debug' | 'trace', enabled: boolean) {
    const orig = _console[method]
    return (...args: unknown[]) => {
      if (enabled) {
        orig(...args)
        reportFrontendLog(method, args.map(fmtConsoleArg).join(' '))
      }
      pushConsole(method, args.map(fmtConsoleArg).join(' '))
    }
  }

  // console 方法级别映射：trace=0 debug=1 log=2(info) warn=3 error=4
  console.log = wrap('log', shouldLog(2))
  console.warn = wrap('warn', shouldLog(3))
  // console.error is never suppressed（始终显示 + 上报）
  console.error = wrap('error', true)
  console.debug = wrap('debug', shouldLog(1))
  console.trace = wrap('trace', shouldLog(0))
}

/** 把 console 参数转成可读字符串（对象序列化，Error 取 stack/message）。 */
function fmtConsoleArg(arg: unknown): string {
  if (arg instanceof Error) return arg.stack || arg.message || String(arg)
  if (typeof arg === 'object' && arg !== null) {
    try { return JSON.stringify(arg) } catch { return String(arg) }
  }
  return String(arg)
}

const savedTheme = localStorage.getItem('qomicex-theme')
if (savedTheme === 'light' || savedTheme === 'dark') {
  document.documentElement.classList.toggle('dark', savedTheme === 'dark')
  document.documentElement.classList.toggle('light', savedTheme === 'light')
} else if (savedTheme === 'system') {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  document.documentElement.classList.toggle('dark', prefersDark)
  document.documentElement.classList.toggle('light', !prefersDark)
}

function I18nMessageBoxProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  return (
    <MessageBoxProvider
      messages={{
        ok: t('common.ok'),
        cancel: t('common.cancel'),
        error: t('common.error'),
        warning: t('common.warning'),
        success: t('common.success'),
        info: t('common.info'),
        input: t('common.input'),
        inputPlaceholder: t('common.inputPlaceholder'),
      }}
    >
      {children}
    </MessageBoxProvider>
  )
}

function App() {
  useEffect(() => {
    console.log(`
 ██████╗   ██████╗  ███╗   ███╗ ██╗  ██████╗ ███████╗ ██╗    ██╗
██╔═══██╗ ██╔═══██╗ ████╗ ████║ ██║ ██╔════╝ ██╔════╝  ╚██╗ ██╔╝
██║   ██║ ██║   ██║ ██╔████╔██║ ██║ ██║      █████╗      ╚██╔╝
██║ █╗██║ ██║   ██║ ██║╚██╔╝██║ ██║ ██║      ██╔══╝      █╔ █╗
██║ ╚██╔╝ ██║   ██║ ██║ ╚═╝ ██║ ██║ ██║      ██║       ██╔╝  ██╗
╚█████╔█╗ ╚██████╔╝ ██║     ██║ ██║ ╚██████╗ ███████╗ ██╔╝    ██╗
 ╚════╝╚╝  ╚═════╝  ╚═╝     ╚═╝ ╚═╝  ╚═════╝  ╚═════╝ ╚═╝     ╚═╝
Console - Qomicex Launcher ======================================`)
  }, [])

  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    // 当前设置的主题模式；'system' 时随系统变化实时重解析
    let currentMode: AppSettings['theme'] = 'dark'
    async function applyResolved(resolved: 'dark' | 'light') {
      document.documentElement.classList.toggle('dark', resolved === 'dark')
      document.documentElement.classList.toggle('light', resolved === 'light')
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        void getCurrentWindow().setTheme(resolved)
      } catch { /* 非 Tauri 环境忽略 */ }
    }
    function setTheme(theme: AppSettings['theme']) {
      currentMode = theme
      const resolved: 'dark' | 'light' = theme === 'system' ? (mql.matches ? 'dark' : 'light') : theme
      localStorage.setItem('qomicex-theme', theme)
      void applyResolved(resolved)
    }
    // 系统主题变化：仅当模式为 system 时响应
    function onSystemThemeChange() {
      if (currentMode !== 'system') return
      void applyResolved(mql.matches ? 'dark' : 'light')
    }
    mql.addEventListener('change', onSystemThemeChange)

    function applyFont(family: string | undefined) {
      const root = document.documentElement
      if (family && family.trim()) {
        root.style.setProperty('--app-font', `'${family.replace(/['"]/g, '')}', sans-serif`)
      } else {
        root.style.removeProperty('--app-font')
      }
    }
    function applyThemePreset(preset: AppSettings['themePreset'] | undefined) {
      const root = document.documentElement
      // 后端缺 themePreset（旧后端丢弃该字段）时回退到前端本地存储，避免切页即回默认。
      const effective = preset ?? (localStorage.getItem('qomicex-theme-preset') as AppSettings['themePreset'] | null) ?? 'default'
      if (effective && effective !== 'default') root.dataset.theme = effective
      else delete root.dataset.theme
    }
    function applyGlassMaterial(material: string | undefined, blur: number | undefined) {
      const root = document.documentElement
      root.dataset.material = material ?? 'default'
      root.style.setProperty('--glass-blur', `${Math.max(0, blur ?? 18)}px`)
    }
    function applyCardStyle(opacity: number | undefined, borderColor: string | undefined, borderWidth: number | undefined) {
      const root = document.documentElement
      // 透明度：0-100 → 0-1；默认 50（半透明）
      const o = Math.min(100, Math.max(0, opacity ?? 50))
      root.style.setProperty('--card-opacity', String(o / 100))
      // 边框颜色：合法 hex 才覆盖，否则回退主题边框色
      if (borderColor && /^#?[0-9a-fA-F]{3}$|^#?[0-9a-fA-F]{6}$/.test(borderColor.trim())) {
        root.style.setProperty('--card-border-color', borderColor.trim())
      } else {
        root.style.removeProperty('--card-border-color')
      }
      // 边框厚度：默认 1px 时移除变量回退；其余（含 0）覆盖
      const w = Math.max(0, borderWidth ?? 1)
      if (w === 1) root.style.removeProperty('--card-border-width')
      else root.style.setProperty('--card-border-width', `${w}px`)
    }
    function applyDialogOpacity(opacity: number | undefined) {
      // 对话框透明度：0-100 → 0-1；默认 75（半透明，独立于卡片材质）
      const o = Math.min(100, Math.max(0, opacity ?? 75))
      document.documentElement.style.setProperty('--dialog-opacity', String(o / 100))
    }
    // 初始设置不在这里加载：backend 可能尚未监听（Tauri release 冷启动要先解压
    // + spawn），fetch 失败会让 UI 用默认值渲染。加载移到 AppContent 中
    // backendState==='ready' 之后；首次加载成功会触发下方 listener 完成初始应用。
    const unsub = onSettingsChange((s: AppSettings) => {
      const enabled = s.animationsEnabled !== false
      const speed = s.animationSpeed ?? 1
      const maxFps = s.maxFrameRate ?? 0
      const fpsScale = maxFps > 0 ? 60 / maxFps : 1
      document.documentElement.dataset.animEnabled = String(enabled)
      document.documentElement.dataset.animGpu = String(s.gpuAcceleration !== false)
      document.documentElement.dataset.maxFps = String(maxFps)
      document.documentElement.style.setProperty('--anim-duration-multiplier', String((1 / speed) * fpsScale))
      window.dispatchEvent(new CustomEvent('qomicex-bg-change'))
      setConsoleLevel(s.logLevel ?? 'info')
      setTheme(s.theme ?? 'dark')
      applyThemePreset(s.themePreset)
      applyFont(s.fontFamily)
      applyThemeColor(s.themeColor)
      applyGlassMaterial(s.componentMaterial, s.glassBlur)
      applyCardStyle(s.cardOpacity, s.cardBorderColor, s.cardBorderWidth)
      applyDialogOpacity(s.dialogOpacity)
    })
    return () => {
      unsub()
      mql.removeEventListener('change', onSystemThemeChange)
    }
  }, [])

  // 恢复持久化的自定义 .qtheme（无已保存主题时 no-op，不影响既有 light/dark/预设流）。
  useEffect(() => {
    restoreSavedTheme()
  }, [])

  useEffect(() => {
    const handler = (event: PromiseRejectionEvent) => {
      console.error('[GLOBAL] Unhandled Promise Rejection:', event.reason)
    }
    window.addEventListener('unhandledrejection', handler)
    return () => window.removeEventListener('unhandledrejection', handler)
  }, [])

  useEffect(() => {
    const handler = (event: ErrorEvent) => {
      console.error('[GLOBAL] Uncaught Error:', event.error ?? event.message)
    }
    window.addEventListener('error', handler)
    return () => window.removeEventListener('error', handler)
  }, [])

  // 独立日志窗口：直接渲染日志页（仍用 I18nProvider 供翻译），
  // 不加载主 Layout / 路由 / 后台健康轮询等重逻辑。
  if (LOG_WINDOW_INSTANCE !== null) {
    return (
      <I18nProvider>
        <GameLogWindow instanceId={LOG_WINDOW_INSTANCE} />
      </I18nProvider>
    )
  }

  // l4 插件独立窗口：轻量启动，只渲染插件页 + 跨窗口桥（见 PluginWebviewPage）。
  if (PLUGIN_WEBVIEW_PLUGIN_ID !== null) {
    return (
      <I18nProvider>
        <PluginWebviewPage pluginId={PLUGIN_WEBVIEW_PLUGIN_ID} />
      </I18nProvider>
    )
  }

  return (
    <I18nProvider>
      <RunningProvider>
        <I18nMessageBoxProvider>
          <ErrorBoundary>
            <AppContent />
          </ErrorBoundary>
        </I18nMessageBoxProvider>
      </RunningProvider>
    </I18nProvider>
  )
}

export default App
