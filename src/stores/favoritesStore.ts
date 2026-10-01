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
    set({ loading: true })
    try {
      const favorites = await listResourceFavorites()
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
    // 快照：任一环节失败都按这份回滚，避免把服务端状态与本地状态弄错位。
    const before = get().favorites
    const exists = before.some((f) => favoriteKey(f.source, f.id, f.category) === key)
    const optimistic = toResourceFavorite(item, category)

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
      // 用服务端条目替换乐观条目，取回服务端生成的 createdAt。
      set({
        favorites: sortByCreatedAtDesc(
          get().favorites.map((f) => (favoriteKey(f.source, f.id, f.category) === key ? saved : f)),
        ),
      })
      return true
    } catch (e) {
      set({ favorites: before })
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
