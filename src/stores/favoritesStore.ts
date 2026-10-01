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

  toggleFavorite: async (item, category) => {
    const key = favoriteKey(item.source, item.id, category)
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
