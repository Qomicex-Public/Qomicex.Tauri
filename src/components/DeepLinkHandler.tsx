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
  parseDeepLink,
  type DeepLinkAction,
} from '../lib/deepLink.ts'

/** 同一条 URL 在「事件」与「挂起队列」两条路径上可能各到一次，短窗内去重。 */
const DEDUPE_WINDOW_MS = 3000

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

/**
 * 深链动作分发（issue #127）。
 *
 * 挂在 `BrowserRouter` 内（需要 `useNavigate`）与 `RunningProvider` 内（需要
 * `launchInstance`）。两条入口最终都汇到同一个 `run`：
 * - **挂起队列**：Rust 侧把冷启动 URL 存入 `PendingDeepLink`，挂载时经
 *   `take_pending_deep_link` 取走（读取即清空）。前端挂载前到达的事件只能靠它，
 *   冷启动必然如此。
 * - **事件**：应用运行中被二次唤起时由 Rust emit `DEEP_LINK_EVENT`。
 *
 * 安全：深链可被任意网页触发，凡是会落地代码的动作都在 `run` 里做来源判定 +
 * 用户确认，见 `lib/deepLink.ts` 的白名单与设计说明。
 */
export default function DeepLinkHandler() {
  const navigate = useNavigate()
  const { confirm, notify } = useMessageBox()
  const { t } = useI18n()
  const { launchInstance } = useRunning()
  const loadPlugins = usePluginStore((s) => s.loadPlugins)

  // 用 ref 持有最新回调，避免依赖变化导致反复重挂监听（重挂窗口内的事件会丢）。
  const depsRef = useRef({ navigate, confirm, notify, t, launchInstance, loadPlugins })
  depsRef.current = { navigate, confirm, notify, t, launchInstance, loadPlugins }

  const seenRef = useRef(new Map<string, number>())

  useEffect(() => {
    if (!isTauri()) return
    let disposed = false

    async function run(action: DeepLinkAction) {
      const { navigate, confirm, notify, t, launchInstance, loadPlugins } = depsRef.current
      const cancel = () => notify(t('deepLink.cancelled'), 'info')

      switch (action.kind) {
        case 'launch': {
          const list = await getInstances()
          const inst =
            list.find((i) => i.name === action.target) ?? list.find((i) => i.id === action.target)
          if (!inst) {
            notify(t('deepLink.launchNotFound', { target: action.target }), 'error')
            return
          }
          await launchInstance(inst.id, inst.name)
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

    function handle(raw: string) {
      const action = parseDeepLink(raw)
      if (!action) return
      const now = Date.now()
      const seen = seenRef.current
      const last = seen.get(raw)
      if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return
      seen.set(raw, now)
      // 顺手清理过期项，避免长会话里 Map 无限增长。
      for (const [key, ts] of seen) {
        if (now - ts >= DEDUPE_WINDOW_MS) seen.delete(key)
      }
      void run(action).catch((e) => console.error('[deep-link] action failed:', e))
    }

    const unlisteners: Array<() => void> = []
    listen<string[]>(DEEP_LINK_EVENT, (event) => {
      if (disposed) return
      for (const url of event.payload ?? []) handle(url)
    })
      .then((fn) => {
        if (disposed) fn()
        else unlisteners.push(fn)
      })
      .catch(() => {})

    // 监听器就绪后再取挂起队列：冷启动 URL 与「挂载前到达」的都在这里。
    invoke<string[]>('take_pending_deep_link')
      .then((urls) => {
        if (disposed) return
        for (const url of urls ?? []) handle(url)
      })
      .catch((e) => console.error('[deep-link] take pending failed:', e))

    return () => {
      disposed = true
      for (const fn of unlisteners) fn()
    }
  }, [])

  return null
}
