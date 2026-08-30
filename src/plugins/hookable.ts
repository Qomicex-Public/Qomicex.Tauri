/**
 * hookable() —— 把启动器任意方法包装成可被插件 hook 的方法。
 *
 * 用法（不改变原调用方式）：
 *   const launch = hookable('launchInstance', async (id, name) => { ...原实现... })
 *   await launch(id, name)
 *
 * 包装后的方法在被调用时：
 *   1. 查询 HookRegistry 中是否有插件注册了同名 hook
 *   2. 有 → 执行洋葱管道（插件可修改 args、prevent、替换结果）
 *   3. 无 → 直接调用原实现（零开销快路径）
 *
 * 注意：wrapper 总是返回 Promise（即使原实现是同步的），因为 hook 是异步的。
 * 启动器中被 hook 的方法本身都是 async，因此无影响。
 */
import { getHookRegistry } from './hook-registry.ts'

export type Hookable<T extends (...args: never[]) => unknown> = (
  ...args: Parameters<T>
) => Promise<Awaited<ReturnType<T>>>

export function hookable<T extends (...args: never[]) => unknown>(method: string, impl: T): Hookable<T> {
  const wrapped = async (...args: Parameters<T>): Promise<Awaited<ReturnType<T>>> => {
    const registry = getHookRegistry()
    const { result } = await registry.run(
      method,
      args,
      ((...a: Parameters<T>) => impl(...a)) as unknown as (...a: unknown[]) => unknown
    )
    return result as Awaited<ReturnType<T>>
  }
  // 记录 hook 方法名，便于调试/停用清理
  ;(wrapped as unknown as { __hookMethod?: string }).__hookMethod = method
  return wrapped
}

/** 判断某方法是否被插件注册了 hook（供调用方选择是否进入 hook 路径） */
export function hasHooks(method: string): boolean {
  const registry = getHookRegistry()
  return registry.snapshot()[method]?.length > 0
}