import { useMemo } from 'react'
import { create } from 'zustand'
import type { ResourceFavorite, ResourceItem } from '../types/index.ts'
import { addResourceFavorite, listResourceFavorites, removeResourceFavorite, toResourceFavorite } from '../api/resource.ts'

/**
 * 收藏唯一键（与后端 `source + id + category` 对齐）。
 *
 * 资源本身没有 `type` 字段，同一个来源 id 在不同分类下是两条独立收藏，因此
 * 分类必须参与键构造。
 */
export function favoriteKey(source: string, id: string, category: string): string {
  return `${source}|${id}|${category}`
}

/** `createdAt` 降序（服务端已排好，本地乐观插入后重排保持同一口径）。 */
function sortByCreatedAtDesc(items: ResourceFavorite[]): ResourceFavorite[] {
  return [...items].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
}

/**
 * mutation 世代号：每次 `toggleFavorite` 开始与结束都自增。
 *
 * `load()` 在发出请求前记下世代号，响应回来时若已变化就**不能提交这份列表**——
 * 客户端没有请求队列，`GET /resource-favorites` 与 POST/DELETE 是彼此独立的请求，
 * 列表响应可能是「mutation 之前」的快照。
 */
let mutationEpoch = 0

/**
 * 进行中的 mutation 数量。
 *
 * 单看世代号不够：`load()` 可能在 mutation **已经发起之后**才发出 GET，此时它取到的
 * 世代号是最新的，但服务端可能还没落库 → 响应仍是旧列表。若在这个瞬间提交，乐观条目
 * 会被抹掉；而 POST 成功后的「替换」也找不到该键，收藏会在 UI 上凭空消失。
 * 因此有 mutation 在飞时一律不提交列表。
 */
let inFlightMutations = 0

/** 有列表响应被丢弃，需要在其后强制重拉一次以与服务端收敛。 */
let reloadPending = false

/** 所有 mutation 收尾后（无 mutation 在飞）执行挂起的强制重拉，最多一次。 */
function maybeReload(): void {
  if (!reloadPending || inFlightMutations > 0) return
  reloadPending = false
  void useFavoritesStore.getState().load(true)
}

/**
 * 每个收藏键一条 mutation 队列（值为「队尾」，即最后一个操作的完成信号）。
 *
 * **为什么必须按 key 串行化**：页面级 busy 状态只在各自页面内生效 ——
 * `ResourceCenter` 的 `favBusyKeys` 与 `ResourceDetail` 的 `favBusy` 互不共享。
 * 列表页的 POST 尚未返回时用户跳到详情页，详情页看到的是**乐观收藏**，于是可以立刻
 * 发起同键 DELETE。两个请求并发时返回顺序无法保证：
 * - 若 POST 响应晚于「已成功的 DELETE」到达，POST 成功分支会把 `saved` 重新插回列表
 *   —— 而此刻没有在飞的 GET，`reloadPending` 为 false，不会触发重拉；
 * - 结果是 UI 显示已收藏，服务端其实已删除，且不会自愈。
 *
 * 串行化后第二个操作在第一个**完全结束**（成功或失败）后才发出，并按当时的真实状态
 * 决策（例如「先加后删」会正确变成一次 add + 一次 remove）。不同键互不阻塞。
 */
const favoriteMutationTails = new Map<string, Promise<void>>()

function serializeByKey<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = favoriteMutationTails.get(key) ?? Promise.resolve()
  // 前一个无论成功失败都要放行本次（失败已经由各自调用方回滚，不该卡住队列）。
  const run = previous.then(operation, operation)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  favoriteMutationTails.set(key, tail)
  void tail.then(() => {
    // 队列排空后清理，避免 Map 随收藏数无界增长（只在仍是队尾时删）。
    if (favoriteMutationTails.get(key) === tail) favoriteMutationTails.delete(key)
  })
  return run
}

interface FavoritesState {
  favorites: ResourceFavorite[]
  /** 是否成功加载过一次（`load()` 默认只在首次真正请求）。 */
  loaded: boolean
  loading: boolean
  /** 加载失败信息（收藏视图展示 + 重试），成功时清空。 */
  error: string | null
  load: (force?: boolean) => Promise<void>
  isFavorite: (source: string, id: string, category: string) => boolean
  /** 切换收藏；返回切换后的状态（true = 已收藏）。失败时回滚并抛出。 */
  toggleFavorite: (item: ResourceItem, category: string) => Promise<boolean>
}

export const useFavoritesStore = create<FavoritesState>((set, get) => ({
  favorites: [],
  loaded: false,
  loading: false,
  error: null,

  load: async (force = false) => {
    const { loaded, loading } = get()
    if (loading) return
    if (loaded && !force) return
    const epochAtStart = mutationEpoch
    set({ loading: true })
    try {
      const favorites = await listResourceFavorites()
      // 有 mutation 在飞、或期间发生过 mutation：这份列表可能是旧快照。不提交，
      // 也不置 `loaded`，改为登记一次强制重拉，等 mutation 收尾后收敛到服务端真值。
      if (inFlightMutations > 0 || mutationEpoch !== epochAtStart) {
        set({ loading: false })
        reloadPending = true
        maybeReload()
        return
      }
      set({ favorites: sortByCreatedAtDesc(favorites ?? []), loaded: true, loading: false, error: null })
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : String(e) })
    }
  },

  isFavorite: (source, id, category) => {
    const key = favoriteKey(source, id, category)
    return get().favorites.some((f) => favoriteKey(f.source, f.id, f.category) === key)
  },

  toggleFavorite: (item, category) => {
    const key = favoriteKey(item.source, item.id, category)
    // 整个 mutation（含乐观更新与回滚）都排在该键的队列里执行：
    // 队列中的第二个操作要按第一个**结束之后**的真实状态决策，所以 `before`/`exists`
    // 必须在队列内计算，不能在外面先算好。
    return serializeByKey(key, async () => {
      // 快照：只用于回滚**本次这个键**，见下方 catch。
      const before = get().favorites
      const exists = before.some((f) => favoriteKey(f.source, f.id, f.category) === key)
      const optimistic = toResourceFavorite(item, category)

      // 立刻让在飞的 load() 作废，并登记一个进行中的 mutation（load() 会据此拒绝提交）。
      mutationEpoch += 1
      inFlightMutations += 1

      if (exists) {
        set({ favorites: before.filter((f) => favoriteKey(f.source, f.id, f.category) !== key) })
      } else {
        set({ favorites: sortByCreatedAtDesc([optimistic, ...before]) })
      }

      try {
        if (exists) {
          await removeResourceFavorite(item.source, item.id, category)
          return false
        }
        const saved = await addResourceFavorite(optimistic)
        // 「插入或替换」而不是纯替换：即便该键因任何原因不在当前列表里，服务端已确认的
        // 条目也必须出现在列表中（纯替换会静默丢掉它）。
        const rest = get().favorites.filter((f) => favoriteKey(f.source, f.id, f.category) !== key)
        set({ favorites: sortByCreatedAtDesc([saved, ...rest]) })
        return true
      } catch (e) {
        // 只回滚当前键：期间可能有别的键已成功（`favBusyKeys` 只挡同键重复点击），
        // 整份 `before` 回滚会把那些成功的改动一起清掉，造成 UI 与服务端不一致。
        const prev = before.find((f) => favoriteKey(f.source, f.id, f.category) === key)
        const rest = get().favorites.filter((f) => favoriteKey(f.source, f.id, f.category) !== key)
        set({ favorites: sortByCreatedAtDesc(prev ? [prev, ...rest] : rest) })
        throw e
      } finally {
        inFlightMutations -= 1
        mutationEpoch += 1
        maybeReload()
      }
    })
  },
}))

/**
 * 收藏键集合：卡片/详情页据此判断是否已收藏，避免每个卡片各自遍历列表。
 */
export function useFavoriteKeys(): Set<string> {
  const favorites = useFavoritesStore((s) => s.favorites)
  return useMemo(
    () => new Set(favorites.map((f) => favoriteKey(f.source, f.id, f.category))),
    [favorites],
  )
}
