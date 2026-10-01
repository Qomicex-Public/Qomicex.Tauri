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
 * `load()` 在发出请求前记下世代号，响应回来时若已变化就**丢弃这份列表**——
 * 它可能是「新增/删除之前」的快照（客户端没有请求队列，`GET /resource-favorites`
 * 与 POST/DELETE 是彼此独立的请求）。丢弃后不置 `loaded`，下次挂载会重新拉取，
 * 从而自愈；若直接接受，过期列表会覆盖已成功的乐观更新，而 `loaded: true`
 * 又会让后续 `load()` 直接返回，状态再也修不回来。
 *
 * 放在模块作用域而非 store state：它不是渲染依赖，不该触发重渲染。
 */
let mutationEpoch = 0

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
      if (mutationEpoch !== epochAtStart) {
        // 期间有 mutation 开始/完成：这份列表可能不含它，丢弃且不置 loaded，
        // 交给下一次 load() 收敛（当前内存状态已是乐观/服务端确认后的结果）。
        set({ loading: false })
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

    mutationEpoch += 1
    if (exists) {
      set({ favorites: before.filter((f) => favoriteKey(f.source, f.id, f.category) !== key) })
    } else {
      set({ favorites: sortByCreatedAtDesc([optimistic, ...before]) })
    }

    try {
      if (exists) {
        await removeResourceFavorite(item.source, item.id, category)
        mutationEpoch += 1
        return false
      }
      const saved = await addResourceFavorite(optimistic)
      // 用服务端条目替换乐观条目，取回服务端生成的 createdAt。
      set({
        favorites: sortByCreatedAtDesc(
          get().favorites.map((f) => (favoriteKey(f.source, f.id, f.category) === key ? saved : f)),
        ),
      })
      mutationEpoch += 1
      return true
    } catch (e) {
      // 只回滚当前键：期间可能有别的键已成功（`favBusyKey` 只挡同键重复点击），
      // 整份 `before` 回滚会把那些成功的改动一起清掉，造成 UI 与服务端不一致。
      const prev = before.find((f) => favoriteKey(f.source, f.id, f.category) === key)
      const rest = get().favorites.filter((f) => favoriteKey(f.source, f.id, f.category) !== key)
      set({ favorites: sortByCreatedAtDesc(prev ? [prev, ...rest] : rest) })
      mutationEpoch += 1
      throw e
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
