// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// 用户 TS 脚本的隔离执行环境。
//
// iframe 使用 sandbox="allow-scripts"（opaque origin）+ CSP 关掉网络/图片/媒体/
// 子框架/worker；脚本只能通过 postMessage 回传低风险宿主调用（Notify/OpenUrl/
// Navigate/Log）。超时后直接销毁 iframe，下一次调用重建。

export interface ScriptHost {
  Notify: (message: string, type?: string) => unknown | Promise<unknown>
  OpenUrl: (url: string) => unknown | Promise<unknown>
  Navigate: (path: string) => unknown | Promise<unknown>
  Log: (message: string) => unknown | Promise<unknown>
  SetProperty: (target: string, property: string, value: unknown) => unknown | Promise<unknown>
  GetProperty: (target: string, property: string) => unknown | Promise<unknown>
  Invoke: (target: string, method: string, args: unknown[]) => unknown | Promise<unknown>
}

const HOST_METHODS = new Set(['Notify', 'OpenUrl', 'Navigate', 'Log', 'SetProperty', 'GetProperty', 'Invoke'])

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
  var hostSeq = 0;
  var hostPending = new Map();
  function callHost(method, args) {
    return new Promise(function (resolve, reject) {
      var id = 'h' + (++hostSeq);
      hostPending.set(id, { resolve: resolve, reject: reject });
      send({ type: 'qomicex-script-host-request', requestId: id, method: method, args: args });
    });
  }
  var host = {
    Notify: function (message, type) { return callHost('Notify', [String(message), type ? String(type) : undefined]); },
    OpenUrl: function (url) { return callHost('OpenUrl', [String(url)]); },
    Navigate: function (path) { return callHost('Navigate', [String(path)]); },
    Log: function (message) { return callHost('Log', [String(message)]); },
    SetProperty: function (target, property, value) { return callHost('SetProperty', [String(target), String(property), value]); },
    GetProperty: function (target, property) { return callHost('GetProperty', [String(target), String(property)]); },
    Invoke: function (target, method, args) { return callHost('Invoke', [String(target), String(method), Array.isArray(args) ? args : (args === undefined ? [] : [args])]); }
  };
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (data && data.type === 'qomicex-script-host-result') {
      var pending = hostPending.get(data.requestId);
      if (!pending) return;
      hostPending.delete(data.requestId);
      if (data.ok) pending.resolve(data.value);
      else pending.reject(new Error(data.error || 'Host call failed'));
      return;
    }
    if (!data || data.type !== 'qomicex-script-run' || typeof data.id !== 'string') return;
    var id = data.id;
    var run = async function () {
      try {
        var fn = new Function('Input', 'Inputs', 'Resources', 'Data', 'Results', 'Host',
          '"use strict"; return (async () => {\\n' + data.code + '\\n})();');
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
    if (data?.type === 'qomicex-script-host-request') {
      void this.handleHostRequest(
        String(data.requestId ?? ''),
        String(data.method ?? ''),
        Array.isArray(data.args) ? data.args : [],
      )
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

  private async handleHostRequest(requestId: string, method: string, args: unknown[]) {
    try {
      if (!HOST_METHODS.has(method)) throw new Error(`未知 Host 方法: ${method}`)
      const fn = (this.host as unknown as Record<string, (...values: unknown[]) => unknown>)[method]
      if (typeof fn !== 'function') throw new Error(`未知 Host 方法: ${method}`)
      const value = await fn.apply(this.host, args)
      this.postHostResult(requestId, true, value)
    } catch (error) {
      this.postHostResult(requestId, false, undefined, error instanceof Error ? error.message : String(error))
    }
  }

  private postHostResult(requestId: string, ok: boolean, value?: unknown, error?: string) {
    let normalized: unknown
    try {
      normalized = value === undefined ? null : JSON.parse(JSON.stringify(value))
    } catch {
      normalized = null
    }
    this.iframe?.contentWindow?.postMessage({
      type: 'qomicex-script-host-result',
      requestId,
      ok,
      value: normalized,
      error,
    }, '*')
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
