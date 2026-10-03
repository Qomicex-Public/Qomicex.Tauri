import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useMessageBox } from './ui'
import { useI18n } from '../i18n/index.tsx'
import { useRunning } from '../contexts/RunningContext.tsx'
import { usePluginStore } from '../stores/pluginStore.ts'
import { getSettings } from '../api/settings.ts'
import { getInstances, installModpackDirect, resolveModpack } from '../api/instance.ts'
import { joinRoom } from '../api/connector.ts'
import { installStorePlugin } from '../api/pluginStore.ts'
import { installPluginFromUrl } from '../api/plugins.ts'
import { ApiError } from '../api/client.ts'
import {
  DEEP_LINK_EVENT,
  isTrustedInstallUrl,
  matchLaunchTarget,
  parseDeepLink,
  type DeepLinkAction,
} from '../lib/deepLink.ts'

/** 同一条 URL 在「事件」与「待处理集合」两条路径上可能各到一次，短窗内去重。 */
const DEDUPE_WINDOW_MS = 3000

/** 「用户拒绝注册协议关联」的记忆键：拒绝后不再每次启动都问。 */
const REGISTER_DECLINED_KEY = 'qomicex-deeplink-register-declined'

/**
 * 已取出、但**尚未处理**的 URL（后端未就绪或组件正被卸载时暂存）。
 *
 * 放模块级而非 ref：`StrictMode` 的双挂载会让组件在处理完之前卸载重建，若把已取出的
 * URL 丢在旧实例里就找不回来了。Rust 侧在收到回执前也不会移除它们，两端配合保证不丢。
 */
const pendingBuffer: string[] = []

/**
 * 当前挂载实例的「处理一条 URL」入口，供缓冲放行时复用。
 *
 * 不放进 React 状态：它只是转发函数，进状态会引发无意义的重渲染；放模块级则能跨
 * 挂载周期指向**当前**活着的那个实例（cleanup 会置回 null，避免指向已卸载实例）。
 */
let dispatchCurrent: ((raw: string) => void) | null = null

function fmtErr(e: unknown): string {
  if (e instanceof ApiError) return e.displayMessage
  if (e instanceof Error) return e.message
  return String(e)
}

function safeHost(raw: string): string {
  try {
    return new URL(raw).hostname
  } catch {
    return raw
  }
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

interface DeepLinkHandlerProps {
  /** 后端 `/health` 通过后才放行动作：冷启动深链的 launch/install 都要打后端。 */
  backendReady: boolean
  /**
   * 设置加载完成才放行动作。
   *
   * 为什么不能只看 `backendReady`：`/health` 通过时 `loadSettings()` 可能仍在路上，
   * 此时 `getSettings()` 返回的是 **DEFAULT_SETTINGS**（`gameDir: '.minecraft'`）。
   * 整合包安装正是读 `getSettings().gameDir` —— 用户实际配的是别的目录时，会装错地方。
   */
  settingsReady: boolean
  /** 引导流程尚未结束（设置未加载 / 初始化向导开着）时不弹协议注册询问，避免叠窗。 */
  blocked: boolean
}

/**
 * 深链动作分发 + 协议关联引导（issue #127）。
 *
 * 挂在 `BrowserRouter` 内（需要 `useNavigate`）与 `RunningProvider` 内（需要
 * `launchInstance`）。三条链路最终都汇到同一个 `process`：
 * - **待处理集合**：Rust 侧把冷启动 URL 存入 `PendingDeepLink`，`take_pending_deep_link`
 *   返回**全部且不清空**，前端处理完一条再用 `complete_deep_link` 逐条回执。
 *   冷启动 URL 只可能从这里拿到（前端挂载前的事件没有接收方）。
 * - **事件**：应用运行中被二次唤起时由 Rust emit `DEEP_LINK_EVENT`。
 * - **模块缓冲**：上一轮已取出但没处理完的（后端未就绪 / 组件卸载）留到下一轮。
 *
 * 为什么消费要等就绪：冷启动时 Rust 早已把 URL 放进集合，而前端挂载时后端可能还在
 * 解压/spawn，设置也可能还没从后端拉回来。此时就发 `launch`/`install` 请求必然失败、
 * 或读到默认 `gameDir` 装错目录，而链接却已被当成「处理过」。等就绪再消费，代价只是
 * 几百毫秒。
 *
 * 安全：深链可被任意网页触发，凡是会落地代码的动作都在 `run` 里做来源判定 +
 * 用户确认，见 `lib/deepLink.ts` 的白名单与设计说明。
 */
export default function DeepLinkHandler({ backendReady, settingsReady, blocked }: DeepLinkHandlerProps) {
  const navigate = useNavigate()
  const { confirm, notify } = useMessageBox()
  const { t } = useI18n()
  const { launchInstance } = useRunning()
  const loadPlugins = usePluginStore((s) => s.loadPlugins)

  // 用 ref 持有最新回调，避免依赖变化导致反复重挂监听（重挂窗口内的事件会丢）。
  const depsRef = useRef({ navigate, confirm, notify, t, launchInstance, loadPlugins })
  depsRef.current = { navigate, confirm, notify, t, launchInstance, loadPlugins }

  // 动作就绪 = 后端可用 **且** 设置已加载。两个条件都必须满足：只看后端会让整合包
  // 安装读到默认 gameDir；只看设置则请求还没有可用的后端。
  const actionsReady = backendReady && settingsReady
  const actionsReadyRef = useRef(actionsReady)
  actionsReadyRef.current = actionsReady

  const seenRef = useRef(new Map<string, number>())
  /** 正在处理中的 URL：防止「事件」与「集合」同时投递同一条时并发跑两遍。 */
  const inFlightRef = useRef(new Set<string>())
  /** 当前挂载是否有效；卸载后取回的结果转入模块缓冲而不是丢弃。 */
  const aliveRef = useRef(true)

  // --- 挂载期：注册监听 + 取回待处理集合 + 暴露给缓冲放行（只做一次） ---
  useEffect(() => {
    if (!isTauri()) return
    aliveRef.current = true

    async function run(action: DeepLinkAction) {
      const { navigate, confirm, notify, t, launchInstance, loadPlugins } = depsRef.current
      const cancel = () => notify(t('deepLink.cancelled'), 'info')

      switch (action.kind) {
        case 'launch': {
          const list = await getInstances()
          // 匹配规则见 `lib/deepLink.ts` 的 `matchLaunchTarget`：ID 优先，可带
          // `目录:实例名` 精确定位，且**同名多命中一律拒绝**而不是静默取第一个。
          const match = matchLaunchTarget(list, {
            raw: action.raw,
            name: action.target,
            dir: action.dir,
          })
          if (match.kind === 'notFound') {
            notify(t('deepLink.launchNotFound', { target: action.raw }), 'error')
            return
          }
          if (match.kind === 'ambiguous') {
            // 给出可直接照抄的示例：拿第一个候选的真实 gameDir 拼，用户复制即用。
            const example = `${match.candidates[0].gameDir}:${match.candidates[0].name}`
            notify(
              t('deepLink.launchAmbiguous', {
                count: match.candidates.length,
                target: action.raw,
                example,
              }),
              'warning',
            )
            return
          }
          await launchInstance(match.instance.id, match.instance.name)
          return
        }

        case 'open': {
          navigate(action.route)
          return
        }

        case 'join': {
          const ok = await confirm(
            t('deepLink.joinConfirmDesc', { code: action.code }),
            t('deepLink.joinConfirmTitle'),
          )
          if (!ok) return cancel()
          // 先切到联机页再发起，用户能立刻看到进度/错误落在正确的位置。
          navigate('/connect')
          try {
            await joinRoom(action.code)
          } catch (e) {
            notify(t('deepLink.joinFailed', { message: fmtErr(e) }), 'error')
          }
          return
        }

        case 'installPlugin': {
          if (action.url) {
            // 官方域免确认；其余一律确认。确认后放行无签名包（与设置页
            // 「本地上传 + 风险确认后重试」同一口径）。
            const trusted = isTrustedInstallUrl(action.url)
            if (!trusted) {
              const ok = await confirm(
                t('deepLink.installPluginConfirmDesc', {
                  host: safeHost(action.url),
                  name: action.url,
                }),
                t('deepLink.installPluginConfirmTitle'),
              )
              if (!ok) return cancel()
            }
            try {
              await installPluginFromUrl(action.url, { allowUnsigned: !trusted })
              await loadPlugins()
              notify(t('deepLink.installStarted'), 'success')
            } catch (e) {
              notify(t('deepLink.installFailed', { message: fmtErr(e) }), 'error')
            }
            return
          }
          if (action.slug) {
            // 商店 slug 没有来源域可判，无法免确认（任何网页都能编一个 slug）。
            const ok = await confirm(
              t('deepLink.installPluginSlugConfirmDesc', { slug: action.slug }),
              t('deepLink.installPluginConfirmTitle'),
            )
            if (!ok) return cancel()
            try {
              await installStorePlugin(action.slug, action.version)
              await loadPlugins()
              notify(t('deepLink.installStarted'), 'success')
            } catch (e) {
              notify(t('deepLink.installFailed', { message: fmtErr(e) }), 'error')
            }
            return
          }
          return
        }

        case 'installModpack': {
          // 深链不带 name 时先解析整合包拿到官方包名，避免把 projectId 当实例名。
          let name = action.name
          if (!name) {
            try {
              const resolved = await resolveModpack(action.source, action.projectId, action.fileId)
              name = resolved.name
            } catch {
              // 解析失败不阻断：下面用 projectId 兜底命名，真正的错误由安装请求报出。
            }
          }
          const finalName = name || action.projectId
          const ok = await confirm(
            t('deepLink.installModpackConfirmDesc', { name: finalName, source: action.source }),
            t('deepLink.installModpackConfirmTitle'),
          )
          if (!ok) return cancel()
          try {
            await installModpackDirect({
              id: finalName,
              type: action.source,
              projectId: action.projectId,
              fileId: action.fileId,
              gameDir: getSettings().gameDir,
            })
            navigate('/instances')
            notify(t('deepLink.installStarted'), 'success')
          } catch (e) {
            notify(t('deepLink.installFailed', { message: fmtErr(e) }), 'error')
          }
          return
        }
      }
    }

    /** 回执：告诉 Rust 这条已处理完，可从待处理集合移除。 */
    async function ack(raw: string) {
      try {
        await invoke<boolean>('complete_deep_link', { url: raw })
      } catch (e) {
        console.error('[deep-link] ack failed:', e)
      }
    }

    /** 处理一条深链，无论成败都回执（失败已弹提示，重试由用户重新点链接发起）。 */
    async function process(raw: string) {
      const now = Date.now()
      const seen = seenRef.current
      const last = seen.get(raw)
      // 短窗内重复到达（同一 URL 既从事件、又从集合投递，或用户连点两次）：
      // **不动手但必须回执**。只 return 不回执会把这条永久留在 Rust 待处理集合里，
      // 下次挂载又取到、又被去重跳过——变成「永远处理不掉也永远不消失」的僵尸项。
      if (last !== undefined && now - last < DEDUPE_WINDOW_MS) {
        void ack(raw)
        return
      }
      // 正在处理中：这一轮由在飞的那次负责回执，此处不能再回执，否则会在它完成前
      // 就把条目移除，失败时失去「留在集合里可重试」的保障。
      if (inFlightRef.current.has(raw)) return

      const action = parseDeepLink(raw)
      if (!action) {
        // 不是本应用的链接 / 参数非法：静默忽略，但要回执，否则会一直留在集合里。
        void ack(raw)
        return
      }

      seen.set(raw, now)
      for (const [key, ts] of seen) {
        if (now - ts >= DEDUPE_WINDOW_MS) seen.delete(key)
      }

      inFlightRef.current.add(raw)
      try {
        await run(action)
      } catch (e) {
        console.error('[deep-link] action failed:', e)
      } finally {
        inFlightRef.current.delete(raw)
        void ack(raw)
      }
    }

    /** 后端未就绪时暂存，就绪后由下面的 effect 放行。 */
    function accept(raw: string) {
      if (!actionsReadyRef.current) {
        if (!pendingBuffer.includes(raw)) pendingBuffer.push(raw)
        return
      }
      void process(raw)
    }

    dispatchCurrent = accept

    const unlisteners: Array<() => void> = []
    // 先注册监听、等它落地后再读集合：「读集合」与「事件投递」之间到达的 URL
    // 否则会两边都捞不到（集合已读走、监听还没挂上）。
    void (async () => {
      try {
        const fn = await listen<string[]>(DEEP_LINK_EVENT, (event) => {
          if (!aliveRef.current) return
          for (const url of event.payload ?? []) accept(url)
        })
        if (!aliveRef.current) {
          fn()
          return
        }
        unlisteners.push(fn)
      } catch (e) {
        // 监听注册失败也要继续读集合：能处理多少算多少。
        console.error('[deep-link] listen failed:', e)
      }
      try {
        const urls = await invoke<string[]>('take_pending_deep_link')
        if (!aliveRef.current) {
          // 组件已卸载但集合已读出：转入模块缓冲交给下一个挂载实例，
          // 而不是丢掉（Rust 侧未收到回执，条目仍在，两端不会各说各话）。
          for (const url of urls ?? []) {
            if (!pendingBuffer.includes(url)) pendingBuffer.push(url)
          }
          return
        }
        for (const url of urls ?? []) accept(url)
      } catch (e) {
        console.error('[deep-link] take pending failed:', e)
      }
    })()

    return () => {
      aliveRef.current = false
      if (dispatchCurrent === accept) dispatchCurrent = null
      for (const fn of unlisteners) fn()
    }
  }, [])

  /**
   * 后端就绪后放行缓冲（含上一轮挂载遗留的）。
   *
   * 单独一个 effect 而不是把就绪态塞进挂载 effect 的依赖：那样每次就绪态变化都要
   * 重挂监听，重挂窗口反而丢事件。这里只做「放行」。
   */
  useEffect(() => {
    if (!actionsReady || !isTauri()) return
    // 逐条摘走而非整表清空：处理期间新到的仍留在缓冲里等下一轮。
    while (pendingBuffer.length > 0) {
      const raw = pendingBuffer.shift()
      if (raw === undefined) break
      dispatchCurrent?.(raw)
    }
  }, [actionsReady])

  // --- 协议关联引导：未关联时询问用户；用户拒绝后不再打扰 ---
  useEffect(() => {
    if (!isTauri() || !backendReady || blocked) return
    if (localStorage.getItem(REGISTER_DECLINED_KEY) === '1') return
    let cancelled = false
    void (async () => {
      try {
        const registered = await invoke<boolean>('deep_link_registration_status')
        if (cancelled || registered) return
        const ok = await confirm(t('deepLink.registerDesc'), t('deepLink.registerTitle'))
        if (cancelled) return
        if (!ok) {
          localStorage.setItem(REGISTER_DECLINED_KEY, '1')
          notify(t('deepLink.registerDeclined'), 'info')
          return
        }
        const done = await invoke<boolean>('register_deep_link')
        if (cancelled) return
        notify(
          t(done ? 'deepLink.registerSuccess' : 'deepLink.registerFailed'),
          done ? 'success' : 'error',
        )
      } catch (e) {
        console.error('[deep-link] registration check failed:', e)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [backendReady, blocked, confirm, notify, t])

  return null
}
