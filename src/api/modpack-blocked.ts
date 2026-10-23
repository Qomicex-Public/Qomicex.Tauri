// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { del, get, post } from './client.ts'
import type { BlockedModFile, BlockedModList } from '../types/index.ts'

/**
 * CurseForge 分发受限文件的补全接口（issue #291）。
 *
 * CurseForge 的作者可以关闭「第三方分发」开关：API 仍返回项目与文件元数据，
 * 但 `downloadUrl` 为 `null`。这是作者的明确拒绝，启动器不得绕过（换 key、
 * 拼 CDN 直链都无效且违反第三方 API 条款），只能引导用户手动下载再补上。
 */

/**
 * 读取实例的待补全清单。实例不存在时抛 `ApiError`（404）。
 *
 * 后端会顺带核对 `mods/` 目录：用户直接把文件放进文件夹也算补上，
 * 清单与下载中心的等待态随之收尾。
 */
export async function getBlockedMods(instanceId: string): Promise<BlockedModList> {
  return get<BlockedModList>(`/modpack/blocked/${encodeURIComponent(instanceId)}`)
}

/**
 * 登记用户手动下载的 jar。
 *
 * 传本机绝对路径而不是上传文件内容：文件本来就在用户机器上，读进内存再重传
 * 一遍纯属浪费（重型 mod 可达几百 MB）。后端按 `fileId` 找清单条目，用条目里的
 * SHA-1 校验——校验失败返回 `BLOCKED_UPLOAD_REJECTED`，不会把版本不对的 jar
 * 放进 `mods/`。源文件不会被删除或移动。
 *
 * 返回补全后的剩余清单，调用方直接用它刷新 UI。`fileId` 省略时由后端按哈希
 * 匹配条目（拖入多个文件时前端不知道哪个对应哪条）。
 */
export async function submitBlockedMod(
  instanceId: string,
  path: string,
  fileId?: number,
): Promise<BlockedModList> {
  const base = `/modpack/blocked/${encodeURIComponent(instanceId)}/submit`
  return post<BlockedModList>(
    fileId === undefined ? base : `${base}/${fileId}`,
    { path },
  )
}

/** 放弃补全：清空清单并结束下载中心的等待态（实例保留）。 */
export async function skipBlockedMods(instanceId: string): Promise<BlockedModList> {
  return del<BlockedModList>(`/modpack/blocked/${encodeURIComponent(instanceId)}`)
}

/** 清单条目里可直接展示的名称：CF 给了 fileName 就用，否则退回 id。 */
export function blockedModLabel(item: BlockedModFile): string {
  const name = item.fileName.trim()
  return name.length > 0 ? name : `project ${item.projectId} / file ${item.fileId}`
}
