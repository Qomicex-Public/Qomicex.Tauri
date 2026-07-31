import { useState } from 'react'
import {
  Button, Badge, Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter,
  Checkbox, Combobox, Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter,
  Input, Label, Select, SelectOption, SelectDivider, Separator,
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell, TableCaption,
  Tabs, TabContent, Textarea, Tooltip,
} from '@qomicex/plugin-ui'
import type { Tab } from '@qomicex/plugin-ui'

const api = (window as any).__PLUGIN_API__

const tabs: Tab[] = [
  { id: 'components', label: '组件库' },
  { id: 'api', label: 'API' },
  { id: 'overlay', label: '悬浮窗' },
  { id: 'settings', label: '设置' },
]

const frameworkOptions = [
  { value: 'react', label: 'React' },
  { value: 'vue', label: 'Vue' },
  { value: 'svelte', label: 'Svelte' },
  { value: 'solid', label: 'Solid' },
]

const sampleData = [
  { id: 1, name: 'Alice', role: '开发者', status: '在线' },
  { id: 2, name: 'Bob', role: '设计师', status: '离线' },
  { id: 3, name: 'Charlie', role: '运维', status: '忙碌' },
]

export default function App() {
  const [tab, setTab] = useState('components')
  const [subTab, setSubTab] = useState('buttons')
  const [inputVal, setInputVal] = useState('')
  const [textareaVal, setTextareaVal] = useState('')
  const [selectedFramework, setSelectedFramework] = useState('react')
  const [comboboxVal, setComboboxVal] = useState('')
  const [checked, setChecked] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [settingsKey, setSettingsKey] = useState('example.setting')
  const [settingsVal, setSettingsVal] = useState('')
  const [overlayContent, setOverlayContent] = useState('')
  const [overlays, setOverlays] = useState<string[]>([])

  const apiCall = (method: string, ...args: any[]) => {
    try {
      api?.call(method, ...args)
    } catch (e) {
      console.error(`api.call(${method}) failed:`, e)
    }
  }

  const readConfig = async () => {
    try {
      const val = await api?.call('getConfig', settingsKey)
      setSettingsVal(val ?? '')
    } catch { setSettingsVal('') }
  }

  const writeConfig = async () => {
    try {
      await api?.call('setConfig', settingsKey, settingsVal)
    } catch (e) { console.error(e) }
  }

  const addOverlay = () => {
    const name = overlayContent.trim()
    if (!name) return
    setOverlays([...overlays, name])
    setOverlayContent('')
  }

  const removeOverlay = (i: number) => {
    setOverlays(overlays.filter((_, idx) => idx !== i))
  }

  return (
    <div className="p-4 max-w-3xl mx-auto">
      <Tabs tabs={tabs} activeTab={tab} onChange={setTab} />

      {/* ========== Tab 1: 组件库 ========== */}
      <TabContent activeTab={tab} tabId="components">
        <div className="mt-4 space-y-6">
          <Tabs
            tabs={[
              { id: 'buttons', label: '按钮' },
              { id: 'cards', label: '卡片' },
              { id: 'form', label: '表单' },
              { id: 'data', label: '数据' },
              { id: 'other', label: '其他' },
            ]}
            activeTab={subTab}
            onChange={setSubTab}
          />

          {/* 按钮 */}
          <TabContent activeTab={subTab} tabId="buttons">
            <Card>
              <CardHeader>
                <CardTitle>按钮 Button</CardTitle>
                <CardDescription>6 种变体 × 4 种尺寸</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <p className="text-sm text-muted-foreground mb-2">default</p>
                  <div className="flex flex-wrap gap-2">
                    <Button>默认</Button>
                    <Button size="sm">小</Button>
                    <Button size="lg">大</Button>
                    <Button size="icon">+</Button>
                  </div>
                </div>
                <Separator />
                <div>
                  <p className="text-sm text-muted-foreground mb-2">secondary</p>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="secondary">次要</Button>
                    <Button variant="secondary" size="sm">小</Button>
                    <Button variant="secondary" size="lg">大</Button>
                  </div>
                </div>
                <Separator />
                <div>
                  <p className="text-sm text-muted-foreground mb-2">destructive</p>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="destructive">危险</Button>
                    <Button variant="destructive" size="sm">小</Button>
                    <Button variant="destructive" size="lg">大</Button>
                  </div>
                </div>
                <Separator />
                <div>
                  <p className="text-sm text-muted-foreground mb-2">outline</p>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline">描边</Button>
                    <Button variant="outline" size="sm">小</Button>
                    <Button variant="outline" size="lg">大</Button>
                  </div>
                </div>
                <Separator />
                <div>
                  <p className="text-sm text-muted-foreground mb-2">ghost</p>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="ghost">幽灵</Button>
                    <Button variant="ghost" size="sm">小</Button>
                    <Button variant="ghost" size="lg">大</Button>
                  </div>
                </div>
                <Separator />
                <div>
                  <p className="text-sm text-muted-foreground mb-2">link</p>
                  <Button variant="link">链接按钮</Button>
                </div>
              </CardContent>
            </Card>
          </TabContent>

          {/* 卡片 */}
          <TabContent activeTab={subTab} tabId="cards">
            <Card>
              <CardHeader>
                <CardTitle>卡片布局 Card</CardTitle>
                <CardDescription>Card + CardHeader + CardTitle + CardDescription + CardContent + CardFooter</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Card>
                    <CardHeader>
                      <CardTitle>简约卡</CardTitle>
                      <CardDescription>仅标题与描述</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm">这里是卡片正文内容，可以放置任意元素。</p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardTitle>带操作</CardTitle>
                      <CardDescription>底部有操作按钮</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm">操作卡片示例。</p>
                    </CardContent>
                    <CardFooter className="flex gap-2 justify-end">
                      <Button variant="ghost" size="sm">取消</Button>
                      <Button size="sm">确认</Button>
                    </CardFooter>
                  </Card>
                </div>
              </CardContent>
            </Card>
          </TabContent>

          {/* 表单 */}
          <TabContent activeTab={subTab} tabId="form">
            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>输入框 Input + Label</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div>
                    <Label>用户名</Label>
                    <Input placeholder="请输入用户名" value={inputVal} onChange={e => setInputVal(e.target.value)} />
                  </div>
                  <div>
                    <Label>密码</Label>
                    <Input type="password" placeholder="请输入密码" />
                  </div>
                  <div>
                    <Label>邮箱</Label>
                    <Input type="email" placeholder="user@example.com" />
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>文本域 Textarea</CardTitle>
                </CardHeader>
                <CardContent>
                  <Textarea placeholder="请输入内容..." value={textareaVal} onChange={e => setTextareaVal(e.target.value)} />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>复选框 Checkbox</CardTitle>
                </CardHeader>
                <CardContent className="flex items-center gap-2">
                  <Checkbox id="agree" checked={checked} onCheckedChange={(v) => setChecked(v === true)} />
                  <Label htmlFor="agree">我同意服务条款</Label>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>选择器 Select</CardTitle>
                </CardHeader>
                <CardContent>
                  <Select value={selectedFramework} onChange={setSelectedFramework}>
                    <SelectOption value="react">React</SelectOption>
                    <SelectOption value="vue">Vue</SelectOption>
                    <SelectDivider />
                    <SelectOption value="svelte">Svelte</SelectOption>
                    <SelectOption value="solid">Solid</SelectOption>
                  </Select>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>组合框 Combobox</CardTitle>
                </CardHeader>
                <CardContent>
                  <Combobox
                    value={comboboxVal}
                    onChange={setComboboxVal}
                    options={frameworkOptions}
                    placeholder="选择框架..."
                  />
                </CardContent>
              </Card>
            </div>
          </TabContent>

          {/* 数据 */}
          <TabContent activeTab={subTab} tabId="data">
            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>表格 Table</CardTitle>
                  <CardDescription>Table + TableHeader + TableBody + TableRow + TableHead + TableCell + TableCaption</CardDescription>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableCaption>团队成员列表</TableCaption>
                    <TableHeader>
                      <TableRow>
                        <TableHead>ID</TableHead>
                        <TableHead>姓名</TableHead>
                        <TableHead>角色</TableHead>
                        <TableHead>状态</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sampleData.map(row => (
                        <TableRow key={row.id}>
                          <TableCell>{row.id}</TableCell>
                          <TableCell>{row.name}</TableCell>
                          <TableCell>{row.role}</TableCell>
                          <TableCell>
                            <Badge variant={row.status === '在线' ? 'default' : row.status === '忙碌' ? 'destructive' : 'secondary'}>
                              {row.status}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>徽标 Badge</CardTitle>
                  <CardDescription>4 种变体：default / secondary / destructive / outline</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-2">
                  <Badge>default</Badge>
                  <Badge variant="secondary">secondary</Badge>
                  <Badge variant="destructive">destructive</Badge>
                  <Badge variant="outline">outline</Badge>
                </CardContent>
              </Card>
            </div>
          </TabContent>

          {/* 其他 */}
          <TabContent activeTab={subTab} tabId="other">
            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>分隔线 Separator</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm">上方内容</p>
                  <Separator />
                  <p className="text-sm">下方内容（分隔线已插入）</p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>工具提示 Tooltip</CardTitle>
                </CardHeader>
                <CardContent className="flex gap-4">
                  <Tooltip content="上方提示" side="top">
                    <Button variant="outline" size="sm">上</Button>
                  </Tooltip>
                  <Tooltip content="下方提示" side="bottom">
                    <Button variant="outline" size="sm">下</Button>
                  </Tooltip>
                  <Tooltip content="左侧提示" side="left">
                    <Button variant="outline" size="sm">左</Button>
                  </Tooltip>
                  <Tooltip content="右侧提示" side="right">
                    <Button variant="outline" size="sm">右</Button>
                  </Tooltip>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>对话框 Dialog</CardTitle>
                </CardHeader>
                <CardContent>
                  <Button onClick={() => setDialogOpen(true)}>打开对话框</Button>
                  <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)}>
                    <DialogHeader onClose={() => setDialogOpen(false)}>
                      <DialogTitle>示例对话框</DialogTitle>
                    </DialogHeader>
                    <DialogBody>
                      <p className="text-sm text-muted-foreground">这是一个完整的对话框示例，包含标题、内容和底部操作区。</p>
                      <Input className="mt-3" placeholder="输入一些内容..." />
                    </DialogBody>
                    <DialogFooter className="flex gap-2 justify-end">
                      <Button variant="ghost" onClick={() => setDialogOpen(false)}>取消</Button>
                      <Button onClick={() => setDialogOpen(false)}>确认</Button>
                    </DialogFooter>
                  </Dialog>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>嵌套 Tabs</CardTitle>
                  <CardDescription>当前子 Tab：{subTab}</CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">组件库中的子标签页使用了嵌套 Tabs 实现。点击上方的子标签页切换查看。</p>
                </CardContent>
              </Card>
            </div>
          </TabContent>
        </div>
      </TabContent>

      {/* ========== Tab 2: API ========== */}
      <TabContent activeTab={tab} tabId="api">
        <div className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>showToast</CardTitle>
              <CardDescription>显示通知消息</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <Button onClick={() => apiCall('showToast', '这是一条普通通知', 'info')}>info</Button>
              <Button onClick={() => apiCall('showToast', '操作成功！', 'success')}>success</Button>
              <Button variant="destructive" onClick={() => apiCall('showToast', '出错了！', 'error')}>error</Button>
              <Button variant="secondary" onClick={() => apiCall('showToast', '警告信息', 'warning')}>warning</Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>navigate</CardTitle>
              <CardDescription>页面导航</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <Button onClick={() => apiCall('navigate', '/')}>首页</Button>
              <Button onClick={() => apiCall('navigate', '/settings')}>设置页</Button>
              <Button onClick={() => apiCall('navigate', '/plugins')}>插件页</Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>getConfig / setConfig</CardTitle>
              <CardDescription>读写插件配置</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex gap-2">
                <Input
                  className="flex-1"
                  placeholder="配置键名"
                  value={settingsKey}
                  onChange={e => setSettingsKey(e.target.value)}
                />
                <Button variant="secondary" onClick={readConfig}>读取</Button>
              </div>
              <div className="flex gap-2">
                <Input
                  className="flex-1"
                  placeholder="配置值"
                  value={settingsVal}
                  onChange={e => setSettingsVal(e.target.value)}
                />
                <Button onClick={writeConfig}>写入</Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>httpRequest</CardTitle>
              <CardDescription>发送 HTTP 请求</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <Button onClick={async () => {
                try {
                  const res = await api?.call('httpRequest', 'https://httpbin.org/get')
                  apiCall('showToast', '请求成功', 'success')
                  console.log('httpRequest result:', res)
                } catch { apiCall('showToast', '请求失败', 'error') }
              }}>GET 示例</Button>
              <Button onClick={async () => {
                try {
                  const res = await api?.call('httpRequest', 'https://httpbin.org/post', {
                    method: 'POST',
                    body: JSON.stringify({ test: true }),
                    headers: { 'Content-Type': 'application/json' },
                  })
                  apiCall('showToast', 'POST 成功', 'success')
                  console.log('httpRequest result:', res)
                } catch { apiCall('showToast', 'POST 失败', 'error') }
              }}>POST 示例</Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>executeCommand</CardTitle>
              <CardDescription>执行系统命令</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <Button onClick={async () => {
                try {
                  const res = await api?.call('executeCommand', 'echo "Hello from plugin"')
                  apiCall('showToast', `执行结果: ${res}`, 'info')
                } catch { apiCall('showToast', '命令执行失败', 'error') }
              }}>echo 测试</Button>
            </CardContent>
          </Card>
        </div>
      </TabContent>

      {/* ========== Tab 3: 悬浮窗 ========== */}
      <TabContent activeTab={tab} tabId="overlay">
        <div className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>悬浮窗管理</CardTitle>
              <CardDescription>创建 / 读取 / 更新 / 删除悬浮窗</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Input
                  className="flex-1"
                  placeholder="输入悬浮窗名称..."
                  value={overlayContent}
                  onChange={e => setOverlayContent(e.target.value)}
                />
                <Button onClick={addOverlay}>创建</Button>
              </div>
              {overlays.length === 0 ? (
                <p className="text-sm text-muted-foreground">暂无悬浮窗，请输入名称创建。</p>
              ) : (
                <div className="space-y-2">
                  {overlays.map((name, i) => (
                    <Card key={i}>
                      <CardContent className="flex items-center justify-between py-3">
                        <span className="text-sm">{name}</span>
                        <Tooltip content="删除">
                          <Button variant="destructive" size="icon" onClick={() => removeOverlay(i)}>×</Button>
                        </Tooltip>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
          <p className="text-xs text-muted-foreground">
            注：以上为本地状态演示。若平台 API 提供 overlay CRUD 方法，可替换 api.call 调用。
          </p>
        </div>
      </TabContent>

      {/* ========== Tab 4: 设置 ========== */}
      <TabContent activeTab={tab} tabId="settings">
        <div className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>插件设置</CardTitle>
              <CardDescription>通过 getConfig/setConfig 读写持久化设置</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>设置键名</Label>
                <Input value={settingsKey} onChange={e => setSettingsKey(e.target.value)} placeholder="example.setting" />
              </div>
              <div>
                <Label>设置值</Label>
                <div className="flex gap-2">
                  <Input
                    className="flex-1"
                    value={settingsVal}
                    onChange={e => setSettingsVal(e.target.value)}
                    placeholder="输入值后点击写入"
                  />
                  <Button onClick={readConfig}>读取</Button>
                  <Button onClick={writeConfig}>写入</Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </TabContent>
    </div>
  )
}
