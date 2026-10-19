// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { getModsMetadata } from '../api/instance-files.ts'

/** 已安装模组在远程平台上的身份：本地文件 + 版本号。 */
export interface InstalledModEntry {
  fileName: string
  version: string
}

/** 远程身份键（`source:id`）→ 已安装文件。 */
export type InstalledModMap = Map<string, InstalledModEntry>

/** 资源卡片 / 安装对话框共用的远程身份键。 */
export function installedResourceKey(source: string, id: string): string {
  return `${source.toLowerCase()}:${id}`
}

const CACHE_TTL_MS = 15_000

interface CacheEntry {
  at: number
  entries: InstalledModMap
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<InstalledModMap>>()
const listeners = new Map<string, Set<() => void>>()

function toMap(metadata: Awaited<ReturnType<typeof getModsMetadata>>): InstalledModMap {
  const map: InstalledModMap = new Map()
  for (const m of metadata) {
    const entry = { fileName: m.fileName, version: m.version }
    // Modrinth 项目 id 是字符串，CurseForge 是数字；统一转成卡片使用的字符串 id。
    if (m.modrinthId) map.set(installedResourceKey('modrinth', m.modrinthId), entry)
    if (m.curseForgeId != null && m.curseForgeId > 0) {
      map.set(installedResourceKey('curseforge', String(m.curseForgeId)), entry)
    }
  }
  return map
}

/**
 * 读取实例已安装模组的远程身份索引。
 *
 * 只做模组：材质包 / 光影 / 数据包的本地元数据目前没有可用的远程 id（core 的反查
 * 仍是 UNMAPPED），拿不到可靠身份时不做名称猜测。
 */
export async function loadInstalledMods(instanceId: string): Promise<InstalledModMap> {
  const cached = cache.get(instanceId)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.entries

  const pending = inflight.get(instanceId)
  if (pending) return pending

  const task = getModsMetadata(instanceId)
    .then((metadata) => {
      const entries = toMap(metadata)
      cache.set(instanceId, { at: Date.now(), entries })
      return entries
    })
    .finally(() => {
      inflight.delete(instanceId)
    })
  inflight.set(instanceId, task)
  return task
}

/** 安装完成后失效该实例的缓存（下次读取重新扫描），并通知正在展示该实例的页面刷新。 */
export function invalidateInstalledMods(instanceId: string): void {
  cache.delete(instanceId)
  const set = listeners.get(instanceId)
  if (!set) return
  for (const listener of set) listener()
}

/** 订阅该实例的已安装索引失效（安装 / 更换版本完成后触发）。返回取消订阅函数。 */
export function subscribeInstalledMods(instanceId: string, listener: () => void): () => void {
  let set = listeners.get(instanceId)
  if (!set) {
    set = new Set()
    listeners.set(instanceId, set)
  }
  set.add(listener)
  return () => {
    const current = listeners.get(instanceId)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) listeners.delete(instanceId)
  }
}
