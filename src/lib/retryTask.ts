// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { createInstance, resolveModpack, startInstall, startModpackInstall } from '../api/instance.ts'
import { autoSelectDownloadSource, getSettings } from '../api/settings.ts'
import type { DownloadTask } from '../types/index.ts'

/** `retryTask` 的返回值：直接喂给 `updateTask`，把卡片重新挂回进行中。 */
export type RetryPatch = Partial<DownloadTask>

function fresh(): RetryPatch {
  return {
    status: 'queued',
    progress: 0,
    error: undefined,
    completedAt: undefined,
    stage: undefined,
    currentFile: undefined,
    currentFileProgress: undefined,
    speed: undefined,
    createdAt: new Date().toISOString(),
  }
}

/**
 * 按任务卡上保存的描述符重建一次失败安装。
 *
 * 为什么不是「重新排队」：安装失败会回滚并删除实例记录（后端
 * `install_instance` / modpack 管线都会 `try_delete`），旧实例已不存在，
 * 必须按描述符重新创建。
 *
 * 抛出的错误由调用方展示在卡片上（保留失败态与原因，不要静默删除任务）。
 */
export async function retryTask(task: DownloadTask): Promise<RetryPatch> {
  const spec = task.retry
  if (!spec) {
    throw new Error('该任务缺少重试参数，无法重建')
  }

  if (spec.kind === 'game') {
    const instance = await createInstance({
      name: spec.name,
      gameVersion: spec.gameVersion,
      loader: spec.loader,
      loaderVersion: spec.loaderVersion,
      gameDir: spec.gameDir,
      maxMemory: 4096,
      icon: spec.icon,
    })

    const settings = getSettings()
    let downloadSource = settings.downloadSource ?? 0
    if (settings.autoSelectDownloadSource) {
      try {
        downloadSource = (await autoSelectDownloadSource()).id
      } catch {
        // 与首次安装一致：自动测速失败时回退到设置里的源，不打断重试。
      }
    }

    await startInstall(
      instance.id,
      spec.loader,
      spec.loaderVersion,
      spec.addons && spec.addons.length > 0 ? spec.addons : undefined,
      settings.downloadThreads || 64,
      settings.versionIsolation !== false,
      downloadSource,
      settings.downloadTimeout ?? 15,
    )
    return { ...fresh(), instanceId: instance.id }
  }

  // modpack：只存了来源与坐标，重试时重新解析清单再安装（避免把
  // iconData/文件清单塞进 localStorage）。
  const resolved = await resolveModpack(spec.source, spec.projectId, spec.versionId)
  const { instanceId } = await startModpackInstall({
    name: spec.name,
    gameVersion: spec.gameVersion || resolved.gameVersion,
    loader: resolved.loader,
    loaderVersion: resolved.loaderVersion,
    gameDir: spec.gameDir,
    versionIsolation: spec.versionIsolation,
    modpackFiles: resolved.files,
    overridesZip: resolved.overridesZip,
    iconData: resolved.iconData,
    modpackName: resolved.name,
    modpackVersion: resolved.version,
    modpackAuthor: resolved.author,
    modpackSummary: resolved.summary,
    source: spec.source,
    projectId: spec.projectId,
    versionId: spec.versionId,
    origin: 'resource-center',
  })
  return { ...fresh(), instanceId }
}
