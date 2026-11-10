// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { post } from './client.ts'

export interface WidgetProxyResponse {
  contentType: string
  body: string
}

/** 经后端代理抓取组件 XML / 数据源（https:443，禁止重定向，512KB 上限）。 */
export function fetchWidgetUrl(url: string, signal?: AbortSignal): Promise<WidgetProxyResponse> {
  return post('/widgets/proxy', { url }, { timeoutMs: 20_000, signal })
}
