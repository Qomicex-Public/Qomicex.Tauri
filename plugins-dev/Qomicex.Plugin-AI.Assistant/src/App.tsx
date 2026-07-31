import { useState, useEffect } from 'react'
import {
  Button, Input, Label, Card, CardHeader, CardTitle, CardDescription, CardContent,
  Combobox,
} from '@qomicex/plugin-ui'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faServer, faKey, faCube, faBolt, faSave, faPlug, faRotate, faCheck,
  faCircleExclamation, faCircleCheck, faRobot, faBookOpen,
} from '@fortawesome/free-solid-svg-icons'
import { getSettings, setSetting } from './api.ts'

export default function App() {
  const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com/v1')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [modelList, setModelList] = useState<string[]>([])
  const [maxCtx, setMaxCtx] = useState(256)
  const [status, setStatus] = useState<{ text: string; ok?: boolean }>({ text: '' })
  const [fetching, setFetching] = useState(false)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    getSettings().then(s => {
      if (s.baseUrl) setBaseUrl(s.baseUrl)
      if (s.deepseekApiKey) setApiKey(s.deepseekApiKey)
      if (s.deepseekModel) setModel(s.deepseekModel)
      if (s.maxCtx) setMaxCtx(s.maxCtx)
      if (s.baseUrl && s.deepseekApiKey) {
        fetchModels(s.deepseekApiKey, s.baseUrl).then(models => {
          if (s.deepseekModel && models) setModel(s.deepseekModel)
        })
      }
    })
  }, [])

  function setStatusMsg(msg: string, ok?: boolean) {
    setStatus({ text: msg, ok })
    if (msg) setTimeout(() => setStatus({ text: '' }), 3000)
  }

  async function fetchModels(key: string, url: string): Promise<string[]> {
    setFetching(true)
    setStatusMsg('正在获取模型列表...')
    try {
      const res = await fetch((url || 'https://api.deepseek.com/v1') + '/models', {
        headers: { Authorization: 'Bearer ' + key }
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error?.message || 'HTTP ' + res.status) }
      const data = await res.json()
      const models: string[] = (data.data || []).map((m: { id: string }) => m.id)
      setModelList(models)
      setStatusMsg(`已加载 ${models.length} 个模型`, true)
      return models
    } catch {
      setStatusMsg('获取失败，可手动输入模型名')
      return []
    } finally {
      setFetching(false)
    }
  }

  async function handleFetchModels() {
    const key = apiKey.trim()
    const url = baseUrl.trim() || 'https://api.deepseek.com/v1'
    if (!key) { setStatusMsg('请输入 API Key'); return }
    await fetchModels(key, url)
  }

  async function handleTestModel() {
    const key = apiKey.trim()
    const url = (baseUrl.trim() || 'https://api.deepseek.com/v1').replace(/\/+$/, '')
    const m = model.trim()
    if (!key) { setStatusMsg('请输入 API Key'); return }
    if (!m) { setStatusMsg('请输入或选择模型'); return }
    setTesting(true)
    setStatusMsg('测试中...')
    try {
      const res = await fetch(url + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({ model: m, messages: [{ role: 'user', content: '返回ok' }], max_tokens: 10 })
      })
      if (res.ok) setStatusMsg('模型可用 ✓', true)
      else { const d = await res.json(); throw new Error(d.error?.message || res.status) }
    } catch (e: unknown) {
      setStatusMsg('测试失败: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setTesting(false)
    }
  }

  async function handleSave() {
    const key = apiKey.trim()
    const url = (baseUrl.trim() || 'https://api.deepseek.com/v1').replace(/\/+$/, '')
    const m = model.trim()
    if (!key) { setStatusMsg('请输入 API Key'); return }
    if (!m) { setStatusMsg('请选择模型'); return }
    setSaving(true)
    try {
      await Promise.all([
        setSetting('deepseekApiKey', key),
        setSetting('deepseekModel', m),
        setSetting('baseUrl', url),
        setSetting('maxCtx', maxCtx),
      ])
      setStatusMsg('配置已保存', true)
    } catch (e: unknown) {
      setStatusMsg('保存失败: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setSaving(false)
    }
  }

  async function handleTestConnection() {
    const key = apiKey.trim()
    const url = (baseUrl.trim() || 'https://api.deepseek.com/v1').replace(/\/+$/, '')
    const m = model.trim() || 'deepseek-chat'
    if (!key) { setStatusMsg('请先输入 API Key'); return }
    setTesting(true)
    setStatusMsg('正在测试...')
    try {
      const res = await fetch(url + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({ model: m, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 })
      })
      if (res.ok) setStatusMsg('连接成功 ✓', true)
      else { const d = await res.json(); throw new Error(d.error?.message || res.status) }
    } catch (e: unknown) {
      setStatusMsg('连接失败: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setTesting(false)
    }
  }

  const modelOptions = modelList.map(m => ({ value: m, label: m }))

  return (
    <div className="p-6 max-w-lg mx-auto">
      <div className="mb-6">
        <h1 className="text-lg font-bold flex items-center gap-2">
          <FontAwesomeIcon icon={faRobot} className="h-5 w-5 text-primary" />
          AI 助手
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">配置 AI API，开启智能助手功能</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FontAwesomeIcon icon={faPlug} className="h-4 w-4 text-primary" />
            API 配置
          </CardTitle>
          <CardDescription>填写 API 连接信息</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label className="flex items-center gap-1.5">
              <FontAwesomeIcon icon={faServer} className="h-3 w-3 text-muted-foreground" />
              API 地址
            </Label>
            <Input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} />
          </div>

          <div>
            <Label className="flex items-center gap-1.5">
              <FontAwesomeIcon icon={faKey} className="h-3 w-3 text-muted-foreground" />
              API Key
            </Label>
            <div className="flex gap-1.5">
              <Input
                type="password"
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder="sk-..."
                className="flex-1"
              />
              <Button variant="ghost" size="sm" onClick={handleFetchModels} disabled={fetching}>
                {fetching
                  ? <FontAwesomeIcon icon={faRotate} className="h-3.5 w-3.5 animate-spin" />
                  : <><FontAwesomeIcon icon={faCube} className="mr-1 h-3 w-3" />获取模型</>}
              </Button>
            </div>
          </div>

          <div>
            <Label className="flex items-center gap-1.5">
              <FontAwesomeIcon icon={faCube} className="h-3 w-3 text-muted-foreground" />
              模型
            </Label>
            <div className="flex gap-1.5">
              <Combobox
                className="flex-1"
                value={model}
                onChange={setModel}
                options={modelOptions}
                placeholder="获取模型后选择或手动输入"
              />
              <Button variant="ghost" size="sm" onClick={handleTestModel} disabled={testing}>
                {testing
                  ? <FontAwesomeIcon icon={faRotate} className="h-3.5 w-3.5 animate-spin" />
                  : <><FontAwesomeIcon icon={faCircleCheck} className="mr-1 h-3 w-3" />测试</>}
              </Button>
            </div>
          </div>

          <div>
            <Label className="flex items-center gap-1.5">
              <FontAwesomeIcon icon={faBolt} className="h-3 w-3 text-muted-foreground" />
              最大上下文 <span className="text-muted-foreground font-normal">{maxCtx}k</span>
            </Label>
            <input
              type="range"
              min={4}
              max={1024}
              value={maxCtx}
              onChange={e => setMaxCtx(Number(e.target.value))}
            />
          </div>
        </CardContent>
      </Card>

      <div className="mt-4 space-y-2">
        <Button className="w-full" onClick={handleSave} disabled={saving}>
          {saving
            ? <FontAwesomeIcon icon={faRotate} className="h-4 w-4 animate-spin" />
            : <><FontAwesomeIcon icon={faSave} className="mr-1.5 h-4 w-4" />保存配置</>}
        </Button>
        <Button variant="ghost" className="w-full" onClick={handleTestConnection} disabled={testing}>
          <FontAwesomeIcon icon={faPlug} className="mr-1.5 h-3.5 w-3.5" />测试连接
        </Button>
      </div>

      {status.text && (
        <p className={`text-xs text-center mt-3 flex items-center justify-center gap-1 ${status.ok ? 'text-primary' : 'text-destructive'}`}>
          <FontAwesomeIcon icon={status.ok ? faCircleCheck : faCircleExclamation} className="h-3 w-3" />
          {status.text}
        </p>
      )}

      <Card className="mt-6">
        <CardContent className="text-xs text-muted-foreground leading-relaxed p-3">
          <div className="font-semibold text-foreground mb-1 flex items-center gap-1.5">
            <FontAwesomeIcon icon={faBookOpen} className="h-3 w-3 text-primary" />
            使用说明
          </div>
          <div>1. 填写 API 地址（默认 Deepseek）和 API Key</div>
          <div>2. 点击「获取模型」拉取可用模型列表（失败时可手动输入模型名）</div>
          <div>3. 选择模型后保存</div>
          <div>4. 点击侧边栏 AI 助手图标打开聊天窗口</div>
          <div className="mt-1.5 text-[11px]">兼容 OpenAI 协议的 API 均可使用（Deepseek / OpenAI / 通义千问 / Groq / 硅基流动等）</div>
        </CardContent>
      </Card>
    </div>
  )
}
