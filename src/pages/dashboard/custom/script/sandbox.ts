// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// 用户 TS 脚本的隔离执行环境。
//
// iframe 使用 sandbox="allow-scripts"（opaque origin）+ CSP 关掉网络/图片/媒体/
// 子框架/worker；脚本只能通过 postMessage 回传低风险宿主调用（Notify/OpenUrl/
// Navigate/Log）。超时后直接销毁 iframe，下一次调用重建。

export interface ScriptHost {
  Notify: (message: string, type?: string) => void
  OpenUrl: (url: string) => void
  Navigate: (path: string) => void
  Log: (message: string) => void
}

export interface ScriptPayload {
  Input: unknown
  Inputs: Record<string, unknown>
  Resources: Record<string, unknown>
  Data: Record<string, unknown>
  Results: Record<string, unknown>
}

export interface ScriptRunResult {
  ok: boolean
  value?: unknown
  error?: string
}

const IFRAME_SRC = `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; connect-src 'none'; img-src 'none'; media-src 'none'; style-src 'none'; font-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'">
</head><body>
<script>
(function () {
  function send(message) { parent.postMessage(message, '*'); }
  function normalize(value) {
    if (value === undefined) return null;
    return JSON.parse(JSON.stringify(value));
  }
  var host = {
    Notify: function (message, type) { send({ type: 'qomicex-script-host', method: 'Notify', args: [String(message), type ? String(type) : undefined] }); },
    OpenUrl: function (url) { send({ type: 'qomicex-script-host', method: 'OpenUrl', args: [String(url)] }); },
    Navigate: function (path) { send({ type: 'qomicex-script-host', method: 'Navigate', args: [String(path)] }); },
    Log: function (message) { send({ type: 'qomicex-script-host', method: 'Log', args: [String(message)] }); }
  };
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.type !== 'qomicex-script-run' || typeof data.id !== 'string') return;
    var id = data.id;
    var run = async function () {
      try {
        var fn = new Function('Input', 'Inputs', 'Resources', 'Data', 'Results', 'Host',
          '"use strict";\\n' + data.code);
        var result = await fn(data.payload.Input, data.payload.Inputs, data.payload.Resources, data.payload.Data, data.payload.Results, host);
        send({ type: 'qomicex-script-result', id: id, ok: true, result: normalize(result) });
      } catch (error) {
        send({ type: 'qomicex-script-result', id: id, ok: false, error: String(error && error.stack ? error.stack : error) });
      }
    };
    void run();
  });
  send({ type: 'qomicex-script-ready' });
})();
</script>
</body></html>`

export class ScriptSandbox {
  private iframe: HTMLIFrameElement | null = null
  private ready: Promise<void> | null = null
  private pending = new Map<string, { resolve: (value: ScriptRunResult) => void; timer: ReturnType<typeof setTimeout>; reject: (error: Error) => void }>()
  private seq = 0
  private readonly host: ScriptHost

  constructor(host: ScriptHost) {
    this.host = host
  }

  private ensure(): Promise<void> {
    if (this.iframe && this.ready) return this.ready
    const iframe = document.createElement('iframe')
    iframe.setAttribute('sandbox', 'allow-scripts')
    iframe.setAttribute('aria-hidden', 'true')
    iframe.style.cssText = 'position:fixed;left:-99999px;top:0;width:1px;height:1px;border:0;visibility:hidden'
    iframe.srcdoc = IFRAME_SRC
    this.iframe = iframe
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('脚本沙箱启动超时')), 5000)
      const onMessage = (event: MessageEvent) => {
        if (event.source !== iframe.contentWindow) return
        if (event.data?.type === 'qomicex-script-ready') {
          clearTimeout(timer)
          window.removeEventListener('message', onMessage)
          resolve()
        }
      }
      window.addEventListener('message', onMessage)
    })
    window.addEventListener('message', this.onMessage)
    document.body.appendChild(iframe)
    return this.ready
  }

  private onMessage = (event: MessageEvent) => {
    if (event.source !== this.iframe?.contentWindow) return
    const data = event.data
    if (data?.type === 'qomicex-script-host') {
      this.handleHostCall(data.method, Array.isArray(data.args) ? data.args : [])
      return
    }
    if (data?.type !== 'qomicex-script-result') return
    const pending = this.pending.get(String(data.id))
    if (!pending) return
    this.pending.delete(String(data.id))
    clearTimeout(pending.timer)
    pending.resolve({
      ok: !!data.ok,
      value: data.result,
      error: typeof data.error === 'string' ? data.error : undefined,
    })
  }

  private handleHostCall(method: string, args: unknown[]) {
    try {
      switch (method) {
        case 'Notify':
          this.host.Notify(String(args[0] ?? ''), typeof args[1] === 'string' ? args[1] : undefined)
          break
        case 'OpenUrl':
          this.host.OpenUrl(String(args[0] ?? ''))
          break
        case 'Navigate':
          this.host.Navigate(String(args[0] ?? ''))
          break
        case 'Log':
          this.host.Log(String(args[0] ?? ''))
          break
        default:
          break
      }
    } catch {
      /* 宿主调用失败不打断脚本结果回传 */
    }
  }

  async run(code: string, payload: ScriptPayload, timeoutMs: number): Promise<ScriptRunResult> {
    await this.ensure()
    const iframe = this.iframe
    if (!iframe?.contentWindow) return { ok: false, error: '脚本沙箱不可用' }
    const id = String(++this.seq)
    return await new Promise<ScriptRunResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.destroy()
        reject(new Error(`脚本执行超过 ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
      this.pending.set(id, { resolve, timer, reject })
      iframe.contentWindow!.postMessage({ type: 'qomicex-script-run', id, code, payload }, '*')
    })
  }

  destroy() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('脚本沙箱已销毁'))
    }
    this.pending.clear()
    if (this.iframe) {
      window.removeEventListener('message', this.onMessage)
      this.iframe.remove()
    }
    this.iframe = null
    this.ready = null
  }
}
