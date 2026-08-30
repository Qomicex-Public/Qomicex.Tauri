/**
 * 通用 Hook 系统核心 —— 主窗口 HookRegistry + iframe 桥协议。
 *
 * 执行模型：Koa 式洋葱中间件管道。每个 hook 是一个
 * `(ctx, next) => Promise<void>`，支持：
 *   - before：在 next() 前修改 ctx.args / 调用 ctx.prevent() 阻止默认实现
 *   - after：在 next() 后读取/修改 ctx.result
 *   - 替换：在 hook 内计算 ctx.result 并 prevent()（跨 iframe 无法传函数，
 *     故"完全替换"以"设置结果 + 跳过默认实现"表达）
 *   - 嵌套：多个插件按注册顺序串行执行，先注册者在外层（洋葱模型）
 *
 * 通信：插件 hook 函数在 iframe 中执行。主窗口触发 hook 时经
 * `__plugin_hook_invoke` postMessage 发到插件 iframe，iframe 执行后
 * `__plugin_hook_result` 回传修改后的 ctx。
 *
 * 本模块只在主窗口（window.top）初始化。iframe 侧的本地 hook 注册表
 * 由 sandbox.ts 的 apiBridgeScript 内联实现（iframe 无法 import 启动器模块）。
 */

import { usePluginStore } from '../stores/pluginStore.ts'

/** 一条 hook 注册（主窗口内存态） */
export interface RegisteredHook {
  pluginId: string
  fn: HookFn
}

/** hook 函数签名：ctx 可修改参数/结果/阻止，next 继续管道 */
export type HookFn = (ctx: HookContext, next: () => Promise<void>) => Promise<void>

/** 传给插件 hook 的 Context 对象（可跨 postMessage 序列化的字段） */
export interface HookContext {
  method: string
  pluginId: string
  args: unknown[]
  result?: unknown
  prevented: boolean
  /** 标记阻止默认实现（等价于"已替换/已接管"） */
  prevent(): void
}

/** run() 返回的管道结果 */
export interface HookRunResult {
  args: unknown[]
  result?: unknown
  prevented: boolean
}

/** iframe 注入的 registerHook 所依赖的宿主能力 */
export interface HookBridgeHost {
  /** 注册/更新一条 hook（同插件同 method 覆盖） */
  register(pluginId: string, method: string, fn: HookFn): void
  /** 注销某插件所有 hook（停用时调用） */
  unregisterAll(pluginId: string): void
  /** 判断某插件是否已注册某方法 hook */
  has(pluginId: string, method: string): boolean
  /** 同步注册表快照（用于 l4 跨窗口事件桥转发） */
  snapshot(): Record<string, RegisteredHook[]>
  /** 触发一条 hook 管道，impl 为默认实现（作为管道终点） */
  run(method: string, args: unknown[], impl?: (...a: unknown[]) => unknown | Promise<unknown>): Promise<HookRunResult>
}

// 主窗口注入点
interface HookWindow extends Window {
  __pluginHookRegistry?: HookRegistry
}

const win = window as HookWindow

/**
 * 主窗口 HookRegistry。持有全量 hook 表（method → RegisteredHook[]），
 * 提供 run() 执行洋葱管道（默认实现为终点）。iframe 侧的注册经
 * postMessage 上报到这里。
 */
class HookRegistry implements HookBridgeHost {
  private hooks = new Map<string, RegisteredHook[]>()

  register(pluginId: string, method: string, fn: HookFn) {
    const list = this.hooks.get(method) ?? []
    const idx = list.findIndex(h => h.pluginId === pluginId)
    if (idx >= 0) list[idx] = { pluginId, fn }
    else list.push({ pluginId, fn })
    this.hooks.set(method, list)
  }

  unregisterAll(pluginId: string) {
    for (const [method, list] of this.hooks) {
      const next = list.filter(h => h.pluginId !== pluginId)
      if (next.length === 0) this.hooks.delete(method)
      else this.hooks.set(method, next)
    }
  }

  has(pluginId: string, method: string): boolean {
    return (this.hooks.get(method) ?? []).some(h => h.pluginId === pluginId)
  }

  snapshot(): Record<string, RegisteredHook[]> {
    const out: Record<string, RegisteredHook[]> = {}
    for (const [method, list] of this.hooks) out[method] = [...list]
    return out
  }

  /** 执行一条 hook 管道（洋葱模型）。返回最终参数、结果与是否被阻止。 */
  async run(method: string, args: unknown[], impl?: (...a: unknown[]) => unknown | Promise<unknown>): Promise<HookRunResult> {
    const list = this.hooks.get(method) ?? []
    if (list.length === 0) {
      if (impl) return { args, result: await impl(...args), prevented: false }
      return { args, prevented: false }
    }

    const ctx: HookContext = {
      method,
      pluginId: '',
      args: [...args],
      prevented: false,
      prevent() { this.prevented = true },
    }

    const dispatch = async (idx: number): Promise<void> => {
      if (ctx.prevented) return
      if (idx >= list.length) {
        if (impl) ctx.result = await impl(...ctx.args)
        return
      }
      const h = list[idx]
      const prevPluginId = ctx.pluginId
      ctx.pluginId = h.pluginId
      try {
        await h.fn(ctx, () => dispatch(idx + 1))
      } finally {
        ctx.pluginId = prevPluginId
      }
    }

    await dispatch(0)

    return { args: ctx.args, result: ctx.result, prevented: ctx.prevented }
  }
}

// ============================================================
// 主窗口：安装真实注册表 + 处理 iframe 上报的注册消息
// ============================================================
if (window === window.top) {
  if (!win.__pluginHookRegistry) win.__pluginHookRegistry = new HookRegistry()

  window.addEventListener('message', (e) => {
    const msg = e.data
    if (!msg?.type) return
    const registry = win.__pluginHookRegistry!
    if (msg.type === '__plugin_hook_register') {
      // iframe 上报：{ pluginId, method } —— fn 留在 iframe，主窗口登记"转发型"
      // hook，触发时经桥转发回 iframe 执行。需 hook:register 权限。
      const plugin = usePluginStore.getState().getPlugin(msg.pluginId)
      if (!plugin || !plugin.manifest.permissions.includes('hook:register')) return
      registry.register(msg.pluginId, msg.method, createFrameHookFn(msg.pluginId, msg.method, e.source as Window))
    } else if (msg.type === '__plugin_hook_unregister_all') {
      registry.unregisterAll(msg.pluginId)
    }
  })
}

/**
 * 创建一个"转发型" hook fn：运行时经 postMessage 把 ctx 发给 iframe 执行，
 * 等 iframe 回传修改后的 ctx（参数/结果/阻止标记），据此决定是否继续默认实现。
 *
 * 跨 iframe 的洋葱模型采用两阶段桥：
 *   阶段1（before）：发 `__plugin_hook_invoke` → iframe 执行 hook 的 before 部分
 *     （修改 args / prevent），回传 `__plugin_hook_before_done` 后挂起在 next()；
 *   阶段2（after）：主窗口继续管道（impl 执行写入 ctx.result）后，发
 *     `__plugin_hook_continue`（带 result）→ iframe 的 next() resolve，
 *     hook 的 after 部分执行并修改 result，回传 `__plugin_hook_after_done`。
 *
 * 这样 plugin 侧写法 `(ctx, next) => { before; await next(); after }` 在
 * iframe 中保持完整洋葱语义（before 先于 impl，after 后于 impl 且能看到结果）。
 */
function createFrameHookFn(pluginId: string, method: string, source: Window): HookFn {
  return async (ctx: HookContext, next: () => Promise<void>) => {
    const callId = Math.random().toString(36).slice(2)

    // 阶段1：before —— 发 invoke，等 iframe 回传 before_done
    const beforeDone = new Promise<void>((resolve) => {
      const handler = (e: MessageEvent) => {
        if (e.data?.type === '__plugin_hook_before_done' && e.data.callId === callId) {
          window.removeEventListener('message', handler)
          const returned = e.data.ctx as HookContext
          ctx.args = returned.args ?? ctx.args
          ctx.result = returned.result
          ctx.prevented = returned.prevented || ctx.prevented
          resolve()
        }
      }
      window.addEventListener('message', handler)
      source.postMessage({
        type: '__plugin_hook_invoke',
        callId,
        payload: { method, pluginId, args: ctx.args, result: ctx.result, prevented: ctx.prevented },
      }, '*')
    })
    await beforeDone
    if (ctx.prevented) return // before 阶段阻止 → 跳过主窗口 impl 与后续 hook

    // 主窗口继续管道（impl 或下一层 hook），result 写入 ctx.result
    await next()

    // 阶段2：after —— 发 continue（带 result），等 iframe 回传 after_done
    const afterDone = new Promise<void>((resolve) => {
      const handler = (e: MessageEvent) => {
        if (e.data?.type === '__plugin_hook_after_done' && e.data.callId === callId) {
          window.removeEventListener('message', handler)
          const returned = e.data.ctx as HookContext
          ctx.result = returned.result ?? ctx.result
          ctx.prevented = returned.prevented || ctx.prevented
          resolve()
        }
      }
      window.addEventListener('message', handler)
      source.postMessage({ type: '__plugin_hook_continue', callId, result: ctx.result }, '*')
    })
    await afterDone
  }
}

/** 主窗口默认导出：hook 注册表实例（供 hookable.ts 使用） */
export function getHookRegistry(): HookRegistry {
  if (!win.__pluginHookRegistry) win.__pluginHookRegistry = new HookRegistry()
  return win.__pluginHookRegistry
}

export default win.__pluginHookRegistry as HookRegistry | undefined