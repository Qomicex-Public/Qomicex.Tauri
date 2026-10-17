// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * l4 插件（独立 WebviewWindow）与主窗口之间的插件注册表桥。
 *
 * 为什么需要：l4 插件的前端跑在独立窗口里，`plugin-registry.ts` 在那个窗口把自己当
 * host，方法只登记进该窗口自己的 `__pluginSources`。主窗口查不到 → `callPlugin` 报
 * 「未提供方法」；反向（l4 插件调别的插件）同样出不了那个窗口。
 *
 * 本模块只描述协议与状态机，不依赖 Tauri：传输层由调用方注入（生产是
 * `emitTo`/`listen`，测试是内存总线），因此可以脱离 Tauri 运行时验证往返、
 * 错误传播与超时。
 *
 * 消息流向：
 *   l4 窗口 --register/unregister--> 主窗口（登记「哪些方法在这个窗口」）
 *   主窗口 --call--> l4 窗口 --result--> 主窗口
 *   l4 窗口 --proxyCall--> 主窗口 --proxyResult--> l4 窗口（l4 调第三方插件）
 */

export const L4_REGISTRY_EVENTS = {
  /** l4 → main：该窗口的注册表桥已就绪（前端已加载，方法可能随后注册） */
  windowReady: 'plugin-l4-registry-window-ready',
  /** l4 → main：某插件在某些方法上已注册 */
  register: 'plugin-l4-registry-register',
  /** l4 → main：插件卸载，清空登记 */
  unregister: 'plugin-l4-registry-unregister',
  /** main → l4：调用该窗口内的插件方法 */
  call: 'plugin-l4-registry-call',
  /** l4 → main：调用结果（result 或 error 二选一） */
  result: 'plugin-l4-registry-result',
  /** l4 → main：l4 插件要求主窗口代为调用其他插件 */
  proxyCall: 'plugin-l4-registry-proxy-call',
  /** main → l4：代调用结果 */
  proxyResult: 'plugin-l4-registry-proxy-result',
} as const

/** l4 窗口的 window label（由 plugin-loader 创建时固定）。 */
export function l4WindowLabel(pluginId: string): string {
  return `plugin-webview-${pluginId}`
}

/** l4 窗口 URL 上承载的插件 id（`?pluginWebview=1&pluginId=<id>`）。 */
function l4SelfPluginIdFromUrl(): string {
  try {
    return new URLSearchParams(window.location.search).get('pluginId') ?? ''
  } catch {
    return ''
  }
}

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * 各 l4 窗口注册的插件方法。`null` 表示该插件已在 l4 窗口激活但尚未注册任何方法
 * （例如刚打开、前端还在加载），此时 `callPlugin` 应给出「界面正在加载」而不是
 * 「未提供方法」。
 */
export interface L4RegistrySnapshot {
  readonly plugins: ReadonlyMap<string, ReadonlySet<string>>
}

/** 传输层抽象。`target` 由发送方给出：主窗口发到具体 l4 窗口 label，l4 窗口发给 `main`。 */
export interface RegistryBus {
  send(event: string, payload: unknown, target: string): void
  on(event: string, handler: (payload: unknown) => void): () => void
}

export interface L4BridgeOptions {
  /** 单次调用超时（毫秒）。l4 窗口被直接关闭时不会有回执，必须兜底。 */
  timeoutMs?: number
  /**
   * l4 窗口所属的插件 id。节点侧上报注册/注销一律用它，不采信调用方传入的
   * pluginId —— 否则窗口内 iframe 可伪造成别的插件，删掉对方的登记。
   */
  selfPluginId?: string
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface CallResultPayload {
  callId: string
  pluginId: string
  result?: unknown
  error?: string
}

interface ProxyCallPayload {
  callId: string
  /** 发起代调用的插件（l4 窗口里的那个），用于定位回执目标窗口 */
  pluginId: string
  targetPluginId: string
  method: string
  args: unknown[]
}

function newCallId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 主窗口侧：登记 l4 窗口的方法，代 l4 窗口调用其他插件。 */
export interface L4HostBridge {
  /** 该插件是否由某个已注册的 l4 窗口提供服务。 */
  has(pluginId: string): boolean
  /** 调用 l4 窗口内的插件方法；未登记时与本地 registry 一样 reject。 */
  call(pluginId: string, method: string, args: unknown[]): Promise<unknown>
  /**
   * 清除某个 l4 窗口的全部登记（窗口关闭 / 插件停用 / 被 iframe 回退替换时调用）。
   * 不清理的话 `has()` 会一直为 true，调用被路由到已消失的窗口，只能等超时。
   */
  unregisterWindow(sourcePluginId: string): void
  dispose(): void
}

/**
 * @param invoke 主窗口的通用调用入口（含 iframe 内插件），供 l4 插件代调用其他插件；
 *               必须能解析到本桥之外的目标，否则会形成回环。
 */
export function createL4HostBridge(bus: RegistryBus, invoke: (pluginId: string, method: string, args: unknown[]) => Promise<unknown>, options: L4BridgeOptions = {}): L4HostBridge {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const plugins = new Map<string, Map<string, string>>() // pluginId → method → label
  const pending = new Map<string, PendingCall>()
  /**
   * 窗口已创建、前端尚未 registerMethod 期间的调用：method → 挂起的 deferred。
   *
   * `createRemoteWebview` 在窗口创建成功时就 resolve，插件资源与 node bridge 还要
   * 稍后才就绪；这段间隙里直接报「未提供方法」会让调用方看到假失败。改为短暂排队，
   * 注册到达时统一唤醒，超时则以明确错误失败。
   */
  const waiting = new Map<string, Array<{ method: string; args: unknown[]; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>>()
  /** 已创建过的 l4 窗口（即使还没注册任何方法）。用于区分「尚未就绪」与「不认识」。 */
  const knownWindows = new Set<string>()

  const settle = (callId: string, error: string | undefined, result: unknown) => {
    const call = pending.get(callId)
    if (!call) return
    pending.delete(callId)
    clearTimeout(call.timer)
    if (error !== undefined) call.reject(new Error(error))
    else call.resolve(result)
  }

  const dispatch = (pluginId: string, method: string, args: unknown[], label: string): Promise<unknown> => new Promise((resolve, reject) => {
    const callId = newCallId()
    const timer = setTimeout(() => {
      pending.delete(callId)
      reject(new Error(`插件 ${pluginId} 的方法 ${method} 调用超时（独立窗口无响应）`))
    }, timeoutMs)
    pending.set(callId, { resolve, reject, timer })
    bus.send(L4_REGISTRY_EVENTS.call, { callId, pluginId, method, args }, label)
  })

  const offs = [
    bus.on(L4_REGISTRY_EVENTS.register, (raw) => {
      const payload = raw as { pluginId?: string; method?: string }
      if (!payload?.pluginId || !payload.method) return
      const methods = plugins.get(payload.pluginId) ?? new Map<string, string>()
      methods.set(payload.method, l4WindowLabel(payload.pluginId))
      plugins.set(payload.pluginId, methods)
      knownWindows.add(payload.pluginId)
      // 唤醒等在该方法上的调用
      const queue = waiting.get(payload.pluginId)
      if (!queue) return
      const rest: typeof queue = []
      for (const item of queue) {
        if (item.method !== payload.method) { rest.push(item); continue }
        clearTimeout(item.timer)
        dispatch(payload.pluginId, item.method, item.args, l4WindowLabel(payload.pluginId)).then(item.resolve, item.reject)
      }
      if (rest.length === 0) waiting.delete(payload.pluginId)
      else waiting.set(payload.pluginId, rest)
    }),
    bus.on(L4_REGISTRY_EVENTS.windowReady, (raw) => {
      // 窗口侧 node bridge 安装完成：此后即使方法还没注册，调用也应排队而不是立即失败
      const pluginId = (raw as { pluginId?: string })?.pluginId
      if (pluginId) knownWindows.add(pluginId)
    }),
    bus.on(L4_REGISTRY_EVENTS.unregister, (raw) => {
      const pluginId = (raw as { pluginId?: string })?.pluginId
      if (pluginId) plugins.delete(pluginId)
    }),
    bus.on(L4_REGISTRY_EVENTS.result, (raw) => {
      const payload = raw as CallResultPayload
      if (!payload?.callId) return
      settle(payload.callId, payload.error, payload.result)
    }),
    // l4 插件要求主窗口代为调用其他插件（它自己看不到主窗口的注册表）。
    // 只在本窗口派发，防止「l4 → 主窗口 → 另一个 l4」被再次转发形成回环。
    bus.on(L4_REGISTRY_EVENTS.proxyCall, (raw) => {
      const payload = raw as ProxyCallPayload
      if (!payload?.callId || !payload.targetPluginId) return
      // 回执要发给发起方所在的 l4 窗口，而不是固定发给 main。
      // 必须用 `Promise.resolve().then(...)` 起链：同步抛错的实现若直接进 `.then`，
      // 回执永远发不出去，调用方只能等到超时（#260）。
      const replyTo = payload.pluginId ? l4WindowLabel(payload.pluginId) : 'main'
      Promise.resolve().then(() => invoke(payload.targetPluginId, payload.method, payload.args ?? [])).then(
        (result) => bus.send(L4_REGISTRY_EVENTS.proxyResult, { callId: payload.callId, result }, replyTo),
        (err) => bus.send(L4_REGISTRY_EVENTS.proxyResult, { callId: payload.callId, error: errorMessage(err) }, replyTo),
      )
    }),
  ]

  return {
    has: (pluginId) => plugins.has(pluginId),
    call: (pluginId, method, args) => {
      const methods = plugins.get(pluginId)
      const label = methods?.get(method)
      if (label) return dispatch(pluginId, method, args, label)
      // 已登记过该插件的其它方法 → 说明窗口活着但这个方法确实不存在，立即报错。
      // 只有「窗口已知、一个方法都还没注册」才是启动间隙，才值得排队等待。
      if (methods && methods.size > 0) {
        return Promise.reject(new Error(`插件 ${pluginId} 未提供方法 ${method}`))
      }
      if (!knownWindows.has(pluginId)) {
        return Promise.reject(new Error(`插件 ${pluginId} 未提供方法 ${method}`))
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const queue = waiting.get(pluginId) ?? []
          const idx = queue.findIndex((i) => i.timer === timer)
          if (idx >= 0) queue.splice(idx, 1)
          if (queue.length === 0) waiting.delete(pluginId)
          reject(new Error(`插件 ${pluginId} 的方法 ${method} 调用超时（独立窗口界面未就绪）`))
        }, timeoutMs)
        const queue = waiting.get(pluginId) ?? []
        queue.push({ method, args, resolve, reject, timer })
        waiting.set(pluginId, queue)
      })
    },
    unregisterWindow: (sourcePluginId) => {
      // 只清该窗口对应的登记：多个 l4 窗口并存时不能误伤其它插件。
      const label = l4WindowLabel(sourcePluginId)
      for (const [pluginId, methods] of plugins) {
        for (const [method, owner] of methods) {
          if (owner === label) methods.delete(method)
        }
        if (methods.size === 0) plugins.delete(pluginId)
      }
      waiting.delete(sourcePluginId)
      knownWindows.delete(sourcePluginId)
    },
    dispose: () => {
      for (const off of offs) off()
      for (const call of pending.values()) {
        clearTimeout(call.timer)
        call.reject(new Error('l4 注册表桥已销毁'))
      }
      for (const queue of waiting.values()) {
        for (const item of queue) {
          clearTimeout(item.timer)
          item.reject(new Error('l4 注册表桥已销毁'))
        }
      }
      pending.clear()
      waiting.clear()
      knownWindows.clear()
      plugins.clear()
    },
  }
}

/** l4 窗口侧：把自己的方法报给主窗口，并把调用请求落到本地插件。 */
export interface L4NodeBridge {
  register(pluginId: string, method: string): void
  unregister(pluginId: string): void
  /** 通告本窗口桥已就绪：此后主窗口对该插件的调用会排队等注册，而不是立即失败。 */
  ready(pluginId: string): void
  /** 转发给主窗口代调用（l4 插件调其他插件时用）。发起方身份由窗口决定，不由调用方指定。 */
  callRemote(targetPluginId: string, method: string, args: unknown[]): Promise<unknown>
  dispose(): void
}

export function createL4NodeBridge(bus: RegistryBus, invokeLocal: (pluginId: string, method: string, args: unknown[]) => Promise<unknown>, options: L4BridgeOptions = {}): L4NodeBridge {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  /**
   * 本窗口所属插件 id：注册/注销/代调用的身份一律用它，不采信 iframe 自报的 id。
   *
   * 未显式配置时从窗口 URL 读（真实运行路径）。两者都取不到属于调用方配置错误：
   * 返回 null 由各入口转成可观测的失败（注册类静默跳过、调用类 reject），
   * 而不是在 message 回调栈里同步抛出（调用方无法兜底，且会打断整条消息处理）。
   */
  const selfPluginId = (): string | null => options.selfPluginId ?? l4SelfPluginIdFromUrl() ?? null
  const pending = new Map<string, PendingCall>()

  const settle = (callId: string, error: string | undefined, result: unknown) => {
    const call = pending.get(callId)
    if (!call) return
    pending.delete(callId)
    clearTimeout(call.timer)
    if (error !== undefined) call.reject(new Error(error))
    else call.resolve(result)
  }

  const offs = [
    bus.on(L4_REGISTRY_EVENTS.call, (raw) => {
      const payload = raw as { callId: string; pluginId: string; method: string; args?: unknown[] }
      if (!payload?.callId) return
      // 同上：同步抛错也必须回执，否则调用方只能等超时
      Promise.resolve().then(() => invokeLocal(payload.pluginId, payload.method, payload.args ?? [])).then(
        (result) => bus.send(L4_REGISTRY_EVENTS.result, { callId: payload.callId, pluginId: payload.pluginId, result }, 'main'),
        (err) => bus.send(L4_REGISTRY_EVENTS.result, { callId: payload.callId, pluginId: payload.pluginId, error: errorMessage(err) }, 'main'),
      )
    }),
    bus.on(L4_REGISTRY_EVENTS.proxyResult, (raw) => {
      const payload = raw as { callId: string; result?: unknown; error?: string }
      if (payload?.callId) settle(payload.callId, payload.error, payload.result)
    }),
  ]

  /** 身份缺失时的统一失败：注册类事件直接跳过并告警，调用类 reject。 */
  const requireSelfPluginId = (): string | null => {
    const id = selfPluginId()
    if (!id) console.warn('[plugin] l4 节点桥缺少自身插件 id（需 options.selfPluginId 或窗口 URL 带 pluginId）')
    return id
  }

  return {
    // 身份一律取本窗口所属插件 id：不信任调用方传入的 pluginId。l4 窗口会把 iframe
    // 消息里的 pluginId 原样转发过来，恶意插件可伪造成别人的 id 发 unregister，
    // 删掉对方的登记。
    register: (_pluginId, method) => {
      const self = requireSelfPluginId()
      if (self) bus.send(L4_REGISTRY_EVENTS.register, { pluginId: self, method }, 'main')
    },
    unregister: (_pluginId) => {
      const self = requireSelfPluginId()
      if (self) bus.send(L4_REGISTRY_EVENTS.unregister, { pluginId: self }, 'main')
    },
    ready: (_pluginId) => {
      const self = requireSelfPluginId()
      if (self) bus.send(L4_REGISTRY_EVENTS.windowReady, { pluginId: self }, 'main')
    },
    /**
     * 转发给主窗口代调用。发起方身份同样取本窗口所属插件 id，不由调用方指定，
     * 避免伪造身份者把回执引到别的窗口。
     */
    callRemote: (targetPluginId, method, args) => new Promise((resolve, reject) => {
      const self = requireSelfPluginId()
      if (!self) {
        reject(new Error('l4 节点桥缺少自身插件 id，无法代调用其他插件'))
        return
      }
      const callId = newCallId()
      const timer = setTimeout(() => {
        pending.delete(callId)
        reject(new Error(`插件 ${targetPluginId} 的方法 ${method} 调用超时（主窗口无响应）`))
      }, timeoutMs)
      pending.set(callId, { resolve, reject, timer })
      bus.send(L4_REGISTRY_EVENTS.proxyCall, { callId, pluginId: self, targetPluginId, method, args }, 'main')
    }),
    dispose: () => {
      for (const off of offs) off()
      for (const call of pending.values()) {
        clearTimeout(call.timer)
        call.reject(new Error('l4 注册表桥已销毁'))
      }
      pending.clear()
    },
  }
}
