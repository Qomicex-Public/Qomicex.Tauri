import { useMemo } from 'react'
import { create } from 'zustand'
import type { ResourceFavorite, ResourceFavoriteFolder, ResourceItem } from '../types/index.ts'
import {
  addResourceFavorite,
  createFavoriteFolder,
  deleteFavoriteFolder,
  listFavoriteFolders,
  listResourceFavorites,
  removeResourceFavorite,
  renameFavoriteFolder,
  toResourceFavorite,
} from '../api/resource.ts'

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

function withoutKey(items: ResourceFavorite[], key: string): ResourceFavorite[] {
  return items.filter((f) => favoriteKey(f.source, f.id, f.category) !== key)
}

/**
 * mutation 世代号：每次 mutation（收藏切换 / 元数据编辑 / 收藏夹增删改）开始与结束都自增。
 *
 * `load()` / `loadFolders()` 在发出请求前记下世代号，响应回来时若已变化就**不能提交
 * 这份列表**——客户端没有请求队列，`GET` 与 POST/DELETE/PUT 是彼此独立的请求，
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

/** 有列表响应被丢弃，需要在其后强制重拉一次以与服务端收敛（收藏与收藏夹各一个标记）。 */
const pendingReload = { favorites: false, folders: false }

/** 所有 mutation 收尾后（无 mutation 在飞）执行挂起的强制重拉，各最多一次。 */
function maybeReload(): void {
  if (inFlightMutations > 0) return
  if (pendingReload.favorites) {
    pendingReload.favorites = false
    void useFavoritesStore.getState().load(true)
  }
  if (pendingReload.folders) {
    pendingReload.folders = false
    void useFavoritesStore.getState().loadFolders(true)
  }
}

/** 丢弃一份过期列表并登记重拉（两个 load 共用的收尾动作）。 */
function discardStaleList(kind: 'favorites' | 'folders'): void {
  pendingReload[kind] = true
  maybeReload()
}

/**
 * 每个收藏键一条 mutation 队列（值为「队尾」，即最后一个操作的完成信号）。
 *
 * **为什么必须按 key 串行化**：页面级 busy 状态只在各自页面内生效 ——
 * `ResourceCenter` 的 `favBusyKeys` 与 `ResourceDetail` 的 `favBusy` 互不共享。
 * 列表页的 POST 尚未返回时用户跳到详情页，详情页看到的是**乐观收藏**，于是可以立刻
 * 发起同键 DELETE。两个请求并发时返回顺序无法保证：
 * - 若 POST 响应晚于「已成功的 DELETE」到达，POST 成功分支会把 `saved` 重新插回列表
 *   —— 而此刻没有在飞的 GET，不会触发重拉；
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

/** 收藏的 P2 元数据补丁（`folderId` / `note` / `tags`）。 */
export interface FavoriteMetaPatch {
  folderId: string | null
  note: string | null
  tags: string[]
}

interface FavoritesState {
  favorites: ResourceFavorite[]
  /** 是否成功加载过一次（`load()` 默认只在首次真正请求）。 */
  loaded: boolean
  loading: boolean
  /** 加载失败信息（收藏视图展示 + 重试），成功时清空。 */
  error: string | null

  /** 收藏夹（P2）。 */
  folders: ResourceFavoriteFolder[]
  foldersLoaded: boolean
  foldersLoading: boolean
  foldersError: string | null

  load: (force?: boolean) => Promise<void>
  loadFolders: (force?: boolean) => Promise<void>
  isFavorite: (source: string, id: string, category: string) => boolean
  /** 切换收藏；返回切换后的状态（true = 已收藏）。失败时回滚并抛出。 */
  toggleFavorite: (item: ResourceItem, category: string) => Promise<boolean>
  /** 更新已收藏条目的 P2 元数据（收藏夹 / 备注 / 标签）。失败时回滚并抛出。 */
  updateFavoriteMeta: (item: ResourceItem, category: string, patch: FavoriteMetaPatch) => Promise<boolean>
  /** 新建收藏夹；重名/空名由服务端拒绝（错误抛出给调用方提示）。 */
  createFolder: (name: string) => Promise<ResourceFavoriteFolder>
  renameFolder: (id: string, name: string) => Promise<ResourceFavoriteFolder>
  /** 删除收藏夹并**级联删除夹内收藏**，返回被删的收藏条数。 */
  deleteFolder: (id: string) => Promise<number>
}

export const useFavoritesStore = create<FavoritesState>((set, get) => ({
  favorites: [],
  loaded: false,
  loading: false,
  error: null,

  folders: [],
  foldersLoaded: false,
  foldersLoading: false,
  foldersError: null,

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
        discardStaleList('favorites')
        return
      }
      set({ favorites: sortByCreatedAtDesc(favorites ?? []), loaded: true, loading: false, error: null })
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : String(e) })
    }
  },

  loadFolders: async (force = false) => {
    const { foldersLoaded, foldersLoading } = get()
    if (foldersLoading) return
    if (foldersLoaded && !force) return
    const epochAtStart = mutationEpoch
    set({ foldersLoading: true })
    try {
      const folders = await listFavoriteFolders()
      if (inFlightMutations > 0 || mutationEpoch !== epochAtStart) {
        set({ foldersLoading: false })
        discardStaleList('folders')
        return
      }
      set({ folders: folders ?? [], foldersLoaded: true, foldersLoading: false, foldersError: null })
    } catch (e) {
      set({ foldersLoading: false, foldersError: e instanceof Error ? e.message : String(e) })
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
        set({ favorites: withoutKey(before, key) })
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
        set({ favorites: sortByCreatedAtDesc([saved, ...withoutKey(get().favorites, key)]) })
        return true
      } catch (e) {
        // 只回滚当前键：期间可能有别的键已成功（`favBusyKeys` 只挡同键重复点击），
        // 整份 `before` 回滚会把那些成功的改动一起清掉，造成 UI 与服务端不一致。
        const prev = before.find((f) => favoriteKey(f.source, f.id, f.category) === key)
        set({
          favorites: sortByCreatedAtDesc(prev ? [prev, ...withoutKey(get().favorites, key)] : withoutKey(get().favorites, key)),
        })
        throw e
      } finally {
        inFlightMutations -= 1
        mutationEpoch += 1
        maybeReload()
      }
    })
  },

  updateFavoriteMeta: (item, category, patch) => {
    const key = favoriteKey(item.source, item.id, category)
    // 与 toggle 共用同一条队列：改备注/夹子和加/删收藏是同一条记录上的写操作，
    // 并发时同样会出现「后写的被先发的响应覆盖」。
    return serializeByKey(key, async () => {
      const before = get().favorites
      const current = before.find((f) => favoriteKey(f.source, f.id, f.category) === key)
      // 编辑入口只对已收藏条目开放；若此刻已被取消收藏则无事可做。
      if (!current) return false

      const optimistic: ResourceFavorite = {
        ...current,
        folderId: patch.folderId,
        note: patch.note,
        tags: patch.tags,
        // createdAt 由服务端保留原值（upsert 命中已有键时不刷新），这里清掉即可。
        createdAt: '',
      }

      mutationEpoch += 1
      inFlightMutations += 1
      set({ favorites: sortByCreatedAtDesc([optimistic, ...withoutKey(before, key)]) })

      try {
        const saved = await addResourceFavorite(optimistic)
        set({ favorites: sortByCreatedAtDesc([saved, ...withoutKey(get().favorites, key)]) })
        return true
      } catch (e) {
        set({ favorites: sortByCreatedAtDesc([current, ...withoutKey(get().favorites, key)]) })
        throw e
      } finally {
        inFlightMutations -= 1
        mutationEpoch += 1
        maybeReload()
      }
    })
  },

  createFolder: async (name) => {
    mutationEpoch += 1
    inFlightMutations += 1
    try {
      const folder = await createFavoriteFolder(name)
      set({ folders: [...get().folders, folder], foldersLoaded: true, foldersError: null })
      return folder
    } finally {
      inFlightMutations -= 1
      mutationEpoch += 1
      maybeReload()
    }
  },

  renameFolder: async (id, name) => {
    mutationEpoch += 1
    inFlightMutations += 1
    try {
      const updated = await renameFavoriteFolder(id, name)
      set({ folders: get().folders.map((f) => (f.id === id ? updated : f)) })
      return updated
    } finally {
      inFlightMutations -= 1
      mutationEpoch += 1
      maybeReload()
    }
  },

  deleteFolder: async (id) => {
    // 先等所有在飞的收藏 mutation 结束：删夹子会**级联删除夹内收藏**，若此刻还有同键
    // POST 在飞，它可能在级联删除之后把条目重新加回来（服务端于是留下一条无夹子的收藏，
    // 而 UI 已按「删掉了」渲染）。
    await Promise.allSettled([...favoriteMutationTails.values()])
    mutationEpoch += 1
    inFlightMutations += 1
    try {
      const res = await deleteFavoriteFolder(id)
      set({
        folders: get().folders.filter((f) => f.id !== id),
        favorites: get().favorites.filter((f) => f.folderId !== id),
      })
      return res.removedFavorites ?? 0
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

/**
 * 收藏夹 id → 收藏夹 的查找表（渲染夹子名/过滤时用）。
 *
 * `folderId` 指向不存在的夹子时（例如手工改过 JSON）由调用方按「未分组」处理。
 */
export function useFolderMap(): Map<string, ResourceFavoriteFolder> {
  const folders = useFavoritesStore((s) => s.folders)
  return useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders])
}
