import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faPlay, faPlus, faComputer, faBox, faLayerGroup } from '@fortawesome/free-solid-svg-icons'
import { Button } from '../components/ui/button.tsx'
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card.tsx'
import { Badge } from '../components/ui/badge.tsx'
import { getSystemInfo } from '../api/system.ts'
import { searchJava } from '../api/java.ts'
import type { SystemInfo, JavaRuntime } from '../types/index.ts'

export default function Dashboard() {
  const navigate = useNavigate()
  const [sysInfo, setSysInfo] = useState<SystemInfo | null>(null)
  const [javaRuntimes, setJavaRuntimes] = useState<JavaRuntime[]>([])

  useEffect(() => {
    Promise.all([getSystemInfo(), searchJava()])
      .then(([sys, java]) => {
        setSysInfo(sys)
        setJavaRuntimes(java)
      })
      .catch(console.error)
  }, [])

  const validJava = javaRuntimes.filter((j) => j.state === 'Valid')

  return (
    <div className="animate-in space-y-6 p-8">
      <div className="relative flex items-center justify-between overflow-hidden rounded-2xl border bg-gradient-to-br from-card to-card/80 p-7">
        <div className="absolute -right-16 -top-16 h-72 w-72 rounded-full bg-primary/10 blur-3xl" />
        <div className="z-10">
          <h2 className="text-xl font-semibold">欢迎使用 Qomicex 启动器</h2>
          <p className="mt-1 text-sm text-muted-foreground">管理你的 Minecraft 游戏版本、账户和模组</p>
        </div>
        <div className="z-10 flex gap-2">
          <Button>
            <FontAwesomeIcon icon={faPlay} className="h-4 w-4" />
            启动游戏
          </Button>
          <Button variant="secondary" onClick={() => navigate('/instances')}>
            <FontAwesomeIcon icon={faPlus} className="h-4 w-4" />
            新建实例
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <FontAwesomeIcon icon={faComputer} className="mr-1.5 h-3 w-3" />
              系统信息
            </CardTitle>
          </CardHeader>
          <CardContent>
            {sysInfo ? (
              <div className="space-y-1.5">
                {[
                  ['操作系统', sysInfo.osName],
                  ['版本', sysInfo.osVersion],
                  ['架构', sysInfo.architecture],
                  ['内存', `${(sysInfo.memory / 1024 / 1024 / 1024).toFixed(1)} GB`],
                ].map(([label, value]) => (
                  <div key={label as string} className="flex items-center justify-between border-b border-border py-1.5 text-sm last:border-0">
                    <span className="text-muted-foreground">{label as string}</span>
                    <span className="font-medium">{value as string}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-3 text-sm text-muted-foreground">加载中...</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <FontAwesomeIcon icon={faLayerGroup} className="mr-1.5 h-3 w-3" />
              Java 运行时
            </CardTitle>
            <Badge variant="secondary">{validJava.length} 个</Badge>
          </CardHeader>
          <CardContent>
            {validJava.length > 0 ? (
              <div className="space-y-1.5">
                {validJava.slice(0, 4).map((j, i) => (
                  <div key={i} className="flex items-center justify-between border-b border-border py-1.5 text-sm last:border-0">
                    <span className="text-muted-foreground">{j.name}</span>
                    <span className="font-medium">{j.version} · {j.arch}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-3 text-sm text-muted-foreground">未检测到 Java 运行时</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">游戏实例</h3>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">0</span>
      </div>

      <div className="flex flex-col items-center gap-3 py-16 text-center text-muted-foreground">
        <FontAwesomeIcon icon={faBox} className="h-10 w-10 opacity-30" />
        <p className="text-sm">还没有游戏实例，点击"新建实例"开始</p>
      </div>
    </div>
  )
}
