import { useCallback, useState } from 'react'
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@qomicex/plugin-ui'
import { getApi, getPluginId } from './api.ts'

export default function App() {
  const api = getApi()
  const id = getPluginId()
  const [log, setLog] = useState('')

  const run = useCallback(async (label: string, fn: () => Promise<unknown>) => {
    try {
      const res = await fn()
      setLog(`✓ ${label}\n${JSON.stringify(res, null, 2)}`)
    } catch (e) {
      setLog(`✗ ${label}\n${e instanceof Error ? e.message : String(e)}`)
    }
  }, [])

  const loadSetting = useCallback(() => {
    run('getSettings', () => api!.call('getSettings', id) as Promise<unknown>)
  }, [api, id, run])

  return (
    <Card className="m-4">
      <CardHeader>
        <CardTitle>你好，{id}</CardTitle>
        <CardDescription>
          插件 API 桥已{api ? '注入' : '未注入（浏览器直开时优雅降级）'}。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="flex gap-2">
          <Button onClick={loadSetting}>读取配置（config:read）</Button>
          <Button
            variant="outline"
            onClick={() => run('showToast', () => api!.call('showToast', '来自插件的提示', 'info'))}
          >
            弹提示（ui:toast）
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              run('proxyFetch', () =>
                api!.call('proxyFetch', { url: 'https://api.qomicex.top/ping', method: 'GET' }) as Promise<unknown>
              )
            }
          >
            网络请求（network:fetch）
          </Button>
        </div>
        {log && <pre className="whitespace-pre-wrap rounded bg-muted p-3 text-xs text-muted-foreground">{log}</pre>}
      </CardContent>
    </Card>
  )
}
