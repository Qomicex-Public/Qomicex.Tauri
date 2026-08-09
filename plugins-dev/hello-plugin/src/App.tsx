import { useCallback, useEffect, useState } from 'react'
import {
  Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle,
  Checkbox, Combobox, Input, Label, MessageBoxProvider, useMessageBox,
  Select, SelectOption, SelectDivider, Separator, Table, TableBody, TableCell,
  TableHead, TableHeader, TableRow, Tabs, TabContent, Textarea, Tooltip,
} from '@qomicex/plugin-ui'
import { getApi, getPluginId } from './api.ts'

function ApiDemo() {
  const api = getApi()
  const [log, setLog] = useState(api ? '点击下方按钮执行 API 调用' : '')
  const [sysInfo] = useState('')
  const [settings, setSettings] = useState<Record<string, unknown>>({})
  const [plugins, setPlugins] = useState<{ id: string; name: string; version: string; status: string }[]>([])
  const [greetArgs, setGreetArgs] = useState('World')

  if (!api) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>未检测到插件 API 桥</CardTitle>
          <CardDescription>当前以普通浏览器直接打开页面，`window.__PLUGIN_API__` 未注入。</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            请通过启动器插件中心安装本插件，或在 Tauri 窗口中打开插件页面以获得完整能力。
          </p>
        </CardContent>
      </Card>
    )
  }

  const run = useCallback(async (label: string, fn: () => Promise<unknown>) => {
    try {
      const res = await fn()
      setLog(`✓ ${label}\n${JSON.stringify(res, null, 2)}`)
    } catch (e) {
      setLog(`✗ ${label}\n${e instanceof Error ? e.message : String(e)}`)
    }
  }, [])

  const loadSysInfo = useCallback(() => {
    run('getSystemInfo', () => api.call('getSystemInfo'))
  }, [api, run])

  const loadSettings = useCallback(() => {
    run('getSettings', async () => {
      const s = await api.call('getSettings') as Record<string, unknown>
      setSettings(s)
      return s
    })
  }, [api, run])

  const loadPlugins = useCallback(() => {
    run('listPlugins', async () => {
      const list = await api.call('listPlugins') as { id: string; name: string; version: string; status: string }[]
      setPlugins(list)
      return list
    })
  }, [api, run])

  useEffect(() => {
    void loadSysInfo()
    void loadSettings()
    void loadPlugins()
    void run('callBackend GET /diagnostics/health', () => api.call('callBackend', '/diagnostics/health'))
  }, [api, loadSysInfo, loadSettings, loadPlugins, run])

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>系统信息</CardTitle>
          <CardDescription>调用 system:info 权限的 getSystemInfo</CardDescription>
        </CardHeader>
        <CardContent>
          <Button size="sm" variant="outline" onClick={() => void loadSysInfo()}>刷新</Button>
          {sysInfo && <pre className="mt-3 max-h-40 overflow-auto rounded-md bg-muted p-3 text-xs">{sysInfo}</pre>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>插件设置 (config:read / config:write)</CardTitle>
          <CardDescription>持久化到后端 /api/plugins/settings/{getPluginId()}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <Label htmlFor="greet">问候语</Label>
              <Input id="greet" value={greetArgs} onChange={(e) => setGreetArgs(e.target.value)} />
            </div>
            <Button onClick={() => void run('setSettings', () => api.call('setSettings', 'greeting', greetArgs))}>保存设置</Button>
            <Button variant="outline" onClick={() => void loadSettings()}>读取设置</Button>
          </div>
          <pre className="max-h-32 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(settings, null, 2)}</pre>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>插件间方法调用 (registerMethod / callPlugin)</CardTitle>
          <CardDescription>本插件注册 demo.greet，再通过 registry 调用自身</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Button onClick={() => void run('registerMethod demo.greet', async () => {
            api.registerMethod('demo.greet', (name) => `Hello, ${name}!`)
            return 'registered'
          })}>注册方法</Button>
          <Button variant="outline" onClick={() => void run('callPlugin self demo.greet', () =>
            api.callPlugin(getPluginId(), 'demo.greet', greetArgs))}>
            调用 demo.greet({greetArgs})
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>其它能力</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void run('showToast', () => api.call('showToast', '这是一条 Toast', 'success'))}>showToast</Button>
          <Button size="sm" variant="outline" onClick={() => void run('proxyFetch', () => api.call('proxyFetch', { url: 'https://api.modrinth.com/v2/tag/game_version', method: 'GET', timeoutMs: 8000 }))}>proxyFetch Modrinth</Button>
          <Button size="sm" variant="secondary" onClick={() => void run('execCommand', () => api.call('execCommand', 'echo hello from plugin'))}>execCommand echo</Button>
          <Button size="sm" variant="outline" onClick={() => void run('download.list', () => api.call('download.list'))}>download.list</Button>
          <Button size="sm" variant="secondary" onClick={() => void run('readText', () => api.call('readText', 'plugin.txt'))}>readText</Button>
          <Button size="sm" variant="outline" onClick={() => void run('navigate', async () => { await api.call('navigate', '/instances'); return 'navigated to /instances' })}>navigate /instances</Button>
          <Button size="sm" variant="secondary" onClick={() => void run('overlay.create', () => api.call('overlay.create', { title: '动态悬浮窗', html: '<div class="p-card"><div class="p-card-title">动态内容</div><button class="p-btn p-btn--primary">OK</button></div>', width: 260, height: 140 }))}>创建动态悬浮窗</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>运行日志</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-xs">{log}</pre>
        </CardContent>
      </Card>

      {plugins.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>已安装插件 (plugin:list)</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>名称</TableHead>
                  <TableHead>版本</TableHead>
                  <TableHead>状态</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {plugins.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-mono">{p.id}</TableCell>
                    <TableCell>{p.name}</TableCell>
                    <TableCell>{p.version}</TableCell>
                    <TableCell>{p.status}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function UiShowcase() {
  const [tab, setTab] = useState('buttons')
  const [sel, setSel] = useState('opt1')
  const [comb, setComb] = useState('react')
  const [checked, setChecked] = useState(true)
  const { notify, alert, confirm, prompt } = useMessageBox()

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Tabs</CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs
            tabs={[
              { id: 'buttons', label: '按钮' },
              { id: 'form', label: '表单' },
              { id: 'overlay', label: '弹窗' },
            ]}
            activeTab={tab}
            onChange={setTab}
          />
          <div className="mt-4">
            <TabContent activeTab={tab} tabId="buttons">
              <div className="flex flex-wrap gap-2">
                <Button>默认</Button>
                <Button variant="secondary">次要</Button>
                <Button variant="outline">描边</Button>
                <Button variant="ghost">幽灵</Button>
                <Button variant="destructive">危险</Button>
                <Button variant="link">链接</Button>
                <Button size="sm">小尺寸</Button>
                <Button size="lg">大尺寸</Button>
                <Button disabled>禁用</Button>
              </div>
            </TabContent>
            <TabContent activeTab={tab} tabId="form">
              <div className="flex max-w-md flex-col gap-4">
                <div>
                  <Label htmlFor="name">名称</Label>
                  <Input id="name" placeholder="输入名称" />
                </div>
                <div>
                  <Label>Select</Label>
                  <Select value={sel} onChange={setSel}>
                    <SelectOption value="opt1">选项一</SelectOption>
                    <SelectOption value="opt2">选项二</SelectOption>
                    <SelectDivider />
                    <SelectOption value="opt3" disabled>选项三（禁用）</SelectOption>
                  </Select>
                </div>
                <div>
                  <Label>Combobox</Label>
                  <Combobox
                    value={comb}
                    onChange={setComb}
                    options={[
                      { value: 'react', label: 'React' },
                      { value: 'vue', label: 'Vue' },
                      { value: 'svelte', label: 'Svelte' },
                      { value: 'angular', label: 'Angular' },
                    ]}
                  />
                </div>
                <div>
                  <Label>多行文本</Label>
                  <Textarea placeholder="描述一下…" />
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={checked} onCheckedChange={(v) => setChecked(v === true)} />
                  我已阅读并同意
                </label>
              </div>
            </TabContent>
            <TabContent activeTab={tab} tabId="overlay">
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void alert('这是一条消息', '提示')}>alert</Button>
                <Button variant="secondary" onClick={() => void confirm('确定继续吗？', '确认')}>confirm</Button>
                <Button variant="outline" onClick={() => void prompt('请输入昵称', '输入', 'Qomicex')}>prompt</Button>
                <Button variant="ghost" onClick={() => notify('通知：操作完成', 'success')}>notify toast</Button>
              </div>
            </TabContent>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>徽章 / 分隔线 / 提示</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Badge>默认</Badge>
          <Badge variant="secondary">次要</Badge>
          <Badge variant="outline">描边</Badge>
          <Badge variant="destructive">危险</Badge>
          <Separator className="h-6 w-px" />
          <Tooltip content="悬浮提示文字" side="top">
            <Button size="sm" variant="outline">Hover 我</Button>
          </Tooltip>
        </CardContent>
      </Card>
    </div>
  )
}

function App() {
  const [activeTab, setActiveTab] = useState('api')
  return (
    <MessageBoxProvider>
      <div className="flex h-full flex-col overflow-hidden">
        <header className="flex items-center gap-3 border-b border-border px-5 py-3">
          <span className="text-base font-semibold">👋 Hello 示例插件</span>
          <Badge variant="secondary">v0.1.0</Badge>
          <Badge variant="outline">id: {getPluginId()}</Badge>
        </header>
        <Tabs
          className="border-b border-border px-5 pt-2"
          tabs={[
            { id: 'api', label: 'API 演示' },
            { id: 'ui', label: '组件库' },
          ]}
          activeTab={activeTab}
          onChange={setActiveTab}
        />
        <div className="flex-1 overflow-auto p-5">
          <TabContent activeTab={activeTab} tabId="api"><ApiDemo /></TabContent>
          <TabContent activeTab={activeTab} tabId="ui"><UiShowcase /></TabContent>
        </div>
      </div>
    </MessageBoxProvider>
  )
}

export default App
