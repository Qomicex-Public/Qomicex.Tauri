// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { post } from './client.ts'

export interface WidgetProxyResponse {
  contentType: string
  body: string
  base64?: string
  size?: number
}

export interface WidgetFetchOptions {
  binary?: boolean
  timeoutMs?: number
}

/** 经后端代理抓取组件 XML / 数据源（https:443，禁止重定向，文本 1MB / 二进制 8MB）。 */
export function fetchWidgetUrl(
  url: string,
  signal?: AbortSignal,
  options: WidgetFetchOptions = {},
): Promise<WidgetProxyResponse> {
  return post(
    '/widgets/proxy',
    { url, binary: options.binary === true },
    { timeoutMs: options.timeoutMs ?? 20_000, signal },
  )
}
