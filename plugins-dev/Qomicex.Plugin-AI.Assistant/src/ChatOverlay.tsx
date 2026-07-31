import { useState, useEffect, useRef, useCallback } from 'react'
import { Button, Input, Label, Tooltip } from '@qomicex/plugin-ui'
import { marked } from 'marked'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faRobot, faStop, faRotateRight, faGear, faPaperPlane, faCopy, faCheck,
  faServer, faKey, faCube, faArrowRight, faBrain, faTriangleExclamation,
} from '@fortawesome/free-solid-svg-icons'
import hljs from 'highlight.js/lib/core'
import jsonLang from 'highlight.js/lib/languages/json'
import bashLang from 'highlight.js/lib/languages/bash'
import javaLang from 'highlight.js/lib/languages/java'
import pythonLang from 'highlight.js/lib/languages/python'
import yamlLang from 'highlight.js/lib/languages/yaml'
import xmlLang from 'highlight.js/lib/languages/xml'
import iniLang from 'highlight.js/lib/languages/ini'
import tsLang from 'highlight.js/lib/languages/typescript'
import jsLang from 'highlight.js/lib/languages/javascript'
import sqlLang from 'highlight.js/lib/languages/sql'
import { getSettings, setSetting } from './api.ts'
import { toolDefs, handleToolCall } from './tools.ts'

hljs.registerLanguage('json', jsonLang)
hljs.registerLanguage('bash', bashLang)
hljs.registerLanguage('shell', bashLang)
hljs.registerLanguage('sh', bashLang)
hljs.registerLanguage('java', javaLang)
hljs.registerLanguage('python', pythonLang)
hljs.registerLanguage('yaml', yamlLang)
hljs.registerLanguage('yml', yamlLang)
hljs.registerLanguage('xml', xmlLang)
hljs.registerLanguage('ini', iniLang)
hljs.registerLanguage('typescript', tsLang)
hljs.registerLanguage('ts', tsLang)
hljs.registerLanguage('javascript', jsLang)
hljs.registerLanguage('js', jsLang)
hljs.registerLanguage('sql', sqlLang)

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

marked.use({
  renderer: {
    code({ text, lang }: { text: string; lang?: string }) {
      const cleanLang = (lang || '').trim().split(/\s+/)[0].toLowerCase()
      const label = cleanLang || 'text'
      const highlighted = cleanLang && hljs.getLanguage(cleanLang)
        ? hljs.highlight(text, { language: cleanLang }).value
        : escapeHtml(text)
      return `<div class="code-wrap"><div class="code-lang">${escapeHtml(label)}</div><pre><code class="hljs">${highlighted}</code></pre></div>`
    },
    html({ text }: { text: string }) {
      return escapeHtml(text)
    },
  },
})

interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | null
  tool_calls?: { id: string; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

interface ToolCall {
  id: string
  name: string
  args: string
}

type DisplayItem =
  | { type: 'msg'; role: 'user'; text: string }
  | { type: 'msg'; role: 'assistant'; text: string }
  | { type: 'progress'; text: string; variant: 'call' | 'result' | 'thought' | 'error' }
  | { type: 'typing' }

const SYSTEM_PROMPT = `你是 QOMICE 启动器的 AI 助手。你可以管理 Minecraft 实例、搜索下载模组、查看系统信息等。

规则：
1. 用户意图不明确时，先问清楚再操作
2. 调用工具前先用 listInstances/getInstance 等确认当前状态
3. 执行耗时操作时每步都向用户报告进度
4. 回答简洁准确
5. 工具返回错误时说明并提供建议`

export default function ChatOverlay() {
  const [view, setView] = useState<'chat' | 'config'>('config')
  const [items, setItems] = useState<DisplayItem[]>([
    { type: 'msg', role: 'assistant', text: '你好！我是 AI 助手。我可以帮你管理 Minecraft 实例、搜索和下载模组、查看系统信息等。有什么需要帮忙的？' }
  ])
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  const [streaming, setStreaming] = useState<string | null>(null)
  const [copiedIdx, setCopiedIdx] = useState(-1)

  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com/v1')
  const [model, setModel] = useState('deepseek-chat')
  const [maxCtx, setMaxCtx] = useState(256)
  const [modelList, setModelList] = useState<string[]>([])
  const [cfgStatus, setCfgStatus] = useState<{ text: string; ok?: boolean }>({ text: '' })

  const rawMsgs = useRef<Message[]>([])
  const abortRef = useRef<AbortController | null>(null)
  const itemsRef = useRef(items)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => { itemsRef.current = items }, [items])
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [items, streaming])

  useEffect(() => {
    getSettings().then(s => {
      if (s.deepseekApiKey) {
        setApiKey(s.deepseekApiKey)
        if (s.baseUrl) setBaseUrl(s.baseUrl)
        if (s.deepseekModel) setModel(s.deepseekModel)
        if (s.maxCtx) setMaxCtx(s.maxCtx)
        setView('chat')
      }
    })
  }, [])

  const add = useCallback((item: DisplayItem) => setItems(prev => [...prev, item]), [])

  function estimateTokens(msgs: Message[]) {
    let n = 0
    for (const m of msgs) {
      if (m.content) n += m.content.length
      if (m.tool_calls) n += JSON.stringify(m.tool_calls).length
    }
    return Math.ceil(n / 4)
  }

  function getCtxPct() {
    const limit = (maxCtx || 256) * 1000
    const tokens = estimateTokens(rawMsgs.current)
    return limit > 0 ? (tokens / limit) * 100 : 0
  }

  async function compressContext(signal: AbortSignal) {
    const limit = (maxCtx || 256) * 1000
    const threshold = Math.ceil(limit * 0.7)
    if (estimateTokens(rawMsgs.current) <= threshold) return

    const keepCount = Math.max(Math.ceil(rawMsgs.current.length * 0.5), 10)
    const oldMsgs = rawMsgs.current.slice(0, -keepCount)

    if (oldMsgs.length < 3) {
      let r = 0
      while (estimateTokens(rawMsgs.current) > threshold && rawMsgs.current.length > 4) {
        rawMsgs.current.shift()
        r++
      }
      if (r > 0) add({ type: 'progress', text: `已裁剪 ${r} 条旧消息`, variant: 'thought' })
      return
    }

    add({ type: 'progress', text: '正在压缩上下文...', variant: 'thought' })
    try {
      const summaryMsgs: Message[] = oldMsgs
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role, content: m.content || '(工具调用)' }))
      const res = await fetch((baseUrl || 'https://api.deepseek.com/v1') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'user', content: '请用一段话概括以上对话的核心要点。只返回概括内容，不要任何前缀。' },
            ...summaryMsgs,
          ],
          max_tokens: 512
        }),
        signal,
      })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const data = await res.json()
      const summary = data.choices[0].message.content
      rawMsgs.current = [
        { role: 'system', content: '【历史摘要】' + summary },
        ...rawMsgs.current.slice(-keepCount)
      ]
      add({ type: 'progress', text: '上下文已压缩，保留摘要', variant: 'result' })
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') return
      add({ type: 'progress', text: 'AI 压缩失败，改用裁剪: ' + (e instanceof Error ? e.message : String(e)), variant: 'error' })
      let r = 0
      while (estimateTokens(rawMsgs.current) > threshold && rawMsgs.current.length > 4) {
        rawMsgs.current.shift()
        r++
      }
    }
  }

  async function streamChat(msgs: Message[], signal: AbortSignal, onDelta: (t: string) => void): Promise<{ content: string; toolCalls: ToolCall[] | null }> {
    const body: Record<string, unknown> = {
      model,
      messages: msgs,
      max_tokens: 4096,
      stream: true,
    }
    if (model !== 'deepseek-reasoner') {
      body.tools = toolDefs
      body.tool_choice = 'auto'
    }
    const res = await fetch((baseUrl || 'https://api.deepseek.com/v1') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) {
      const d = await res.json().catch(() => null)
      throw new Error(d?.error?.message || 'API error: ' + res.status)
    }
    if (!res.body) throw new Error('流式响应不可用')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let content = ''
    const toolMap = new Map<number, ToolCall>()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const t = line.trim()
        if (!t.startsWith('data:')) continue
        const data = t.slice(5).trim()
        if (data === '[DONE]') return { content, toolCalls: toolMap.size ? [...toolMap.values()] : null }
        let j: { choices?: { delta?: { content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string }[] }
        try { j = JSON.parse(data) } catch { continue }
        const choice = j.choices?.[0]
        if (!choice) continue
        const delta = choice.delta || {}
        if (typeof delta.content === 'string' && delta.content) {
          content += delta.content
          onDelta(delta.content)
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0
            const cur = toolMap.get(idx) || { id: '', name: '', args: '' }
            if (tc.id) cur.id = tc.id
            if (tc.function?.name) cur.name += tc.function.name
            if (tc.function?.arguments) cur.args += tc.function.arguments
            toolMap.set(idx, cur)
          }
        }
      }
    }
    return { content, toolCalls: toolMap.size ? [...toolMap.values()] : null }
  }

  async function sendMessage(text: string) {
    if (thinking) return
    setThinking(true)
    setInput('')
    add({ type: 'msg', role: 'user', text })
    rawMsgs.current.push({ role: 'user', content: text })

    const controller = new AbortController()
    abortRef.current = controller
    const signal = controller.signal

    await compressContext(signal)
    if (signal.aborted) { cleanup(); return }

    setStreaming('')

    try {
      const sysMsg: Message = { role: 'system', content: SYSTEM_PROMPT }
      let msgs: Message[] = [sysMsg, ...rawMsgs.current]
      let loops = 10

      while (loops > 0) {
        loops--
        const result = await streamChat(msgs, signal, t => setStreaming(prev => (prev ?? '') + t))
        if (signal.aborted) { cleanup(); return }
        setStreaming(null)

        if (result.toolCalls && result.toolCalls.length > 0) {
          const tcNames = result.toolCalls.map(t => t.name).join(', ')
          add({ type: 'progress', text: tcNames, variant: 'thought' })
          rawMsgs.current.push({
            role: 'assistant',
            content: result.content || null,
            tool_calls: result.toolCalls.map(t => ({ id: t.id, function: { name: t.name, arguments: t.args } }))
          })

          for (const tc of result.toolCalls) {
            let args: Record<string, unknown> = {}
            try { args = JSON.parse(tc.args) } catch { /* ignore */ }
            add({ type: 'progress', text: tc.name + '(' + JSON.stringify(args).slice(0, 80) + ')', variant: 'call' })
            let res2: unknown
            try {
              res2 = await handleToolCall(tc.name, args)
            } catch (e: unknown) {
              res2 = { error: e instanceof Error ? e.message : String(e) }
            }
            const summary = typeof res2 === 'object' && res2 !== null
              ? (Array.isArray(res2) ? '返回 ' + res2.length + ' 项' : ((res2 as Record<string, unknown>).error ? '错误: ' + (res2 as Record<string, unknown>).error : '完成'))
              : String(res2).slice(0, 50)
            add({ type: 'progress', text: String(summary), variant: 'result' })
            rawMsgs.current.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(res2) })
          }

          msgs = [sysMsg, ...rawMsgs.current]
          setStreaming('')
          continue
        }

        rawMsgs.current.push({ role: 'assistant', content: result.content || '' })
        add({ type: 'msg', role: 'assistant', text: result.content || '(空响应)' })
        break
      }

      if (loops <= 0) {
        add({ type: 'msg', role: 'assistant', text: '抱歉，工具调用次数过多，请重试。' })
      }
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') { cleanup(); return }
      setStreaming(null)
      add({ type: 'msg', role: 'assistant', text: '出错了: ' + (e instanceof Error ? e.message : String(e)) })
    }
    cleanup()

    function cleanup() {
      setThinking(false)
      setStreaming(null)
      abortRef.current = null
    }
  }

  function stopGeneration() {
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null }
    setThinking(false)
    setStreaming(null)
    add({ type: 'msg', role: 'assistant', text: '（已停止）' })
  }

  function newChat() {
    rawMsgs.current = []
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null }
    setThinking(false)
    setStreaming(null)
    setItems([
      { type: 'msg', role: 'assistant', text: '你好！我是 AI 助手。有什么需要帮忙的？' }
    ])
  }

  async function copyMessage(idx: number, text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedIdx(idx)
      setTimeout(() => setCopiedIdx(-1), 1500)
    } catch { /* ignore */ }
  }

  async function handleTest() {
    const key = apiKey.trim()
    const url = (baseUrl.trim() || 'https://api.deepseek.com/v1').replace(/\/+$/, '')
    const m = model.trim()
    if (!key) { setCfgStatus({ text: '请输入 API Key' }); return }
    if (!m) { setCfgStatus({ text: '请输入或选择模型' }); return }
    setCfgStatus({ text: '测试中...' })
    try {
      const res = await fetch(url + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ model: m, messages: [{ role: 'user', content: '返回ok' }], max_tokens: 10 })
      })
      if (res.ok) { setCfgStatus({ text: '模型可用 ✓', ok: true }); setTimeout(() => setCfgStatus({ text: '' }), 2500) }
      else { const d = await res.json(); throw new Error(d.error?.message || res.status) }
    } catch (e: unknown) {
      setCfgStatus({ text: '测试失败: ' + (e instanceof Error ? e.message : String(e)) })
      setTimeout(() => setCfgStatus({ text: '' }), 4000)
    }
  }

  async function fetchModels(key: string, url: string): Promise<string[]> {
    setCfgStatus({ text: '正在获取模型列表...' })
    try {
      const res = await fetch((url || 'https://api.deepseek.com/v1') + '/models', {
        headers: { Authorization: 'Bearer ' + key }
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error?.message || 'HTTP ' + res.status) }
      const data = await res.json()
      const models: string[] = (data.data || []).map((m: { id: string }) => m.id)
      setModelList(models)
      setCfgStatus({ text: '已加载 ' + models.length + ' 个模型', ok: true })
      setTimeout(() => setCfgStatus({ text: '' }), 3000)
      return models
    } catch {
      setCfgStatus({ text: '获取失败，可手动输入模型名' })
      setTimeout(() => setCfgStatus({ text: '' }), 4000)
      return []
    }
  }

  async function saveConfig() {
    const key = apiKey.trim()
    const url = (baseUrl.trim() || 'https://api.deepseek.com/v1').replace(/\/+$/, '')
    const m = model.trim()
    if (!key) { setCfgStatus({ text: '请输入 API Key' }); return }
    if (!m) { setCfgStatus({ text: '请先获取模型列表并选择模型' }); return }
    try {
      await Promise.all([
        setSetting('deepseekApiKey', key),
        setSetting('deepseekModel', m),
        setSetting('baseUrl', url),
        setSetting('maxCtx', maxCtx),
      ])
      newChat()
      setView('chat')
      setCfgStatus({ text: '' })
    } catch (e: unknown) {
      setCfgStatus({ text: '保存失败: ' + (e instanceof Error ? e.message : String(e)) })
    }
  }

  const PROGRESS_ICONS = {
    call: faArrowRight,
    result: faCheck,
    thought: faBrain,
    error: faTriangleExclamation,
  }

  if (view === 'config') {
    return (
      <div className="h-full flex flex-col p-5 overflow-y-auto bg-background">
        <div className="flex items-center gap-2 justify-center mb-4">
          <FontAwesomeIcon icon={faRobot} className="h-5 w-5 text-primary" />
          <p className="text-sm text-muted-foreground">请配置 AI API</p>
        </div>
        <div className="space-y-2.5">
          <div>
            <Label>API 地址</Label>
            <div className="flex gap-1.5">
              <div className="relative flex-1">
                <FontAwesomeIcon icon={faServer} className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                <Input className="pl-8" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} />
              </div>
            </div>
          </div>
          <div>
            <Label>API Key</Label>
            <div className="flex gap-1.5">
              <div className="relative flex-1">
                <FontAwesomeIcon icon={faKey} className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                <Input type="password" className="pl-8" placeholder="sk-..." value={apiKey} onChange={e => setApiKey(e.target.value)} />
              </div>
              <Button variant="ghost" size="sm" onClick={() => fetchModels(apiKey, baseUrl)}>获取模型</Button>
            </div>
          </div>
          <div>
            <Label>模型</Label>
            <div className="flex gap-1.5">
              <div className="relative flex-1">
                <FontAwesomeIcon icon={faCube} className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                <Input
                  list="cfgModelList" placeholder="点击获取模型或手动输入" className="pl-8"
                  value={model} onChange={e => setModel(e.target.value)}
                />
                <datalist id="cfgModelList">
                  {modelList.map(m => <option key={m} value={m} />)}
                </datalist>
              </div>
              <Button variant="ghost" size="sm" onClick={handleTest}>测试</Button>
            </div>
          </div>
          <div>
            <Label>最大上下文 <span className="text-muted-foreground font-normal">{maxCtx}k</span></Label>
            <input type="range" min={4} max={1024} value={maxCtx} onChange={e => setMaxCtx(Number(e.target.value))} />
          </div>
          <Button className="w-full" onClick={saveConfig}>保存并开始</Button>
          {cfgStatus.text && (
            <p className={`text-xs text-center ${cfgStatus.ok ? 'text-primary' : 'text-destructive'}`}>
              {cfgStatus.text}
            </p>
          )}
        </div>
      </div>
    )
  }

  const pct = getCtxPct()
  const tokenStr = estimateTokens(rawMsgs.current) >= 1000
    ? (estimateTokens(rawMsgs.current) / 1000).toFixed(1) + 'K'
    : estimateTokens(rawMsgs.current) + ''

  return (
    <div className="h-full flex flex-col min-h-0 bg-background relative overflow-hidden">
      <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-border shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <FontAwesomeIcon icon={faRobot} className="h-3.5 w-3.5 text-primary shrink-0" />
          <span className="font-semibold text-sm whitespace-nowrap">AI 助手</span>
          <Tooltip content={model}>
            <span className="max-w-[90px] truncate rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {model}
            </span>
          </Tooltip>
          <span className={`text-[11px] whitespace-nowrap ${pct > 70 ? 'text-destructive' : 'text-muted-foreground'}`}>
            {tokenStr} ({pct.toFixed(0)}%)
          </span>
        </div>
        <div className="flex gap-1 shrink-0">
          {thinking && (
            <Tooltip content="停止输出">
              <Button variant="ghost" size="icon" className="text-destructive" onClick={stopGeneration}>
                <FontAwesomeIcon icon={faStop} className="h-3.5 w-3.5" />
              </Button>
            </Tooltip>
          )}
          <Tooltip content="新对话">
            <Button variant="ghost" size="icon" onClick={newChat}>
              <FontAwesomeIcon icon={faRotateRight} className="h-3.5 w-3.5" />
            </Button>
          </Tooltip>
          <Tooltip content="设置">
            <Button variant="ghost" size="icon" onClick={() => setView('config')}>
              <FontAwesomeIcon icon={faGear} className="h-3.5 w-3.5" />
            </Button>
          </Tooltip>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2 min-h-0" id="chatMsgs">
        {items.map((item, i) => {
          if (item.type === 'typing') {
            return (
              <div key={i} className="msg-bubble self-start bg-muted text-muted-foreground rounded-lg px-3 py-2 text-xs">
                <span>正在思考</span>
                <span><span className="flow-1">.</span><span className="flow-2">.</span><span className="flow-3">.</span></span>
              </div>
            )
          }
          if (item.type === 'progress') {
            return (
              <div key={i} className="progress-line self-start text-muted-foreground text-[11px] whitespace-pre-wrap break-words leading-relaxed pl-1 pt-0.5 pb-0.5">
                <span className={`progress-icon ${item.variant}`}>
                  <FontAwesomeIcon icon={PROGRESS_ICONS[item.variant]} className="h-2.5 w-2.5" />
                </span>
                <span className="min-w-0">{item.text}</span>
              </div>
            )
          }
          const isUser = item.role === 'user'
          return (
            <div key={i} className={`msg-row ${isUser ? 'user' : ''}`}>
              <div
                className={`msg-bubble px-3 py-2 rounded-lg max-w-[85%] break-words leading-relaxed ${isUser ? 'self-end bg-primary text-primary-foreground' : 'self-start bg-muted text-foreground'}`}
              >
                {isUser ? item.text : <MarkdownRenderer text={item.text} />}
              </div>
              {!isUser && (
                <div className="msg-actions">
                  <button
                    type="button"
                    onClick={() => copyMessage(i, item.text)}
                    className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    aria-label="复制"
                  >
                    <FontAwesomeIcon icon={copiedIdx === i ? faCheck : faCopy} className="h-3 w-3" />
                  </button>
                </div>
              )}
            </div>
          )
        })}

        {streaming !== null && (
          <div className="msg-row">
            <div className="msg-bubble self-start bg-muted text-foreground rounded-lg px-3 py-2 max-w-[85%]">
              {streaming ? (
                <MarkdownRenderer text={streaming} />
              ) : (
                <span className="text-muted-foreground text-xs">
                  正在思考
                  <span className="flow-1">.</span><span className="flow-2">.</span><span className="flow-3">.</span>
                </span>
              )}
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="flex gap-2 p-3 pt-2 border-t border-border">
        <Input
          className="flex-1"
          placeholder="输入消息..."
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && input.trim() && !thinking) sendMessage(input.trim()) }}
          disabled={thinking}
        />
        <Button onClick={() => { if (input.trim()) sendMessage(input.trim()) }} disabled={thinking || !input.trim()}>
          <FontAwesomeIcon icon={faPaperPlane} className="h-3.5 w-3.5" />
          <span className="ml-1.5 hidden sm:inline">发送</span>
        </Button>
      </div>
    </div>
  )
}

function MarkdownRenderer({ text }: { text: string }) {
  const html = marked.parse(text, { breaks: true, gfm: true }) as string
  return <div className="md-body" dangerouslySetInnerHTML={{ __html: html }} />
}
