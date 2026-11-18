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

/** 应用内下载进度快照（后端按 instanceId+fileId 记录）。 */
export interface BlockedFetchProgress {
  downloaded: number
  total?: number
  done: boolean
  error?: string
}

/**
 * 由启动器下载受限文件。
 *
 * `url` 是页面倒计时结束后请求的 CDN 地址（仅允许 `*.forgecdn.net`）；后端流式
 * 下载、按清单 SHA-1 校验后放进 `mods/`。与 WebView2 自带下载栈无关，因此能
 * 提供进度并在完成后回填清单。
 */
export async function fetchBlockedMod(
  instanceId: string,
  fileId: number,
  url: string,
): Promise<BlockedModList> {
  return post<BlockedModList>(`/modpack/blocked/${encodeURIComponent(instanceId)}/fetch`, {
    fileId,
    url,
  })
}

/** 轮询应用内下载进度；下载结束后仍保留最后一份快照。 */
export async function getBlockedFetchProgress(
  instanceId: string,
  fileId: number,
): Promise<BlockedFetchProgress> {
  return get<BlockedFetchProgress>(
    `/modpack/blocked/${encodeURIComponent(instanceId)}/fetch/${fileId}/progress`,
  )
}

/**
 * 从系统下载文件夹补全：后端按 SHA-1（无哈希条目按文件名）匹配清单，
 * 命中的文件复制进 `mods/` 并从清单移除，源文件保留。
 *
 * 返回补全后的剩余清单；没有命中时清单原样返回，调用方据此提示。
 */
export async function scanBlockedDownloads(instanceId: string): Promise<BlockedModList> {
  return post<BlockedModList>(
    `/modpack/blocked/${encodeURIComponent(instanceId)}/scan-downloads`,
  )
}

/** 清单条目里可直接展示的名称：CF 给了 fileName 就用，否则退回 id。 */
export function blockedModLabel(item: BlockedModFile): string {
  const name = item.fileName.trim()
  return name.length > 0 ? name : `project ${item.projectId} / file ${item.fileId}`
}
