import { callBackend, showToast } from './api.ts'

export interface ToolParam {
  type: 'object'
  properties: Record<string, unknown>
  required: string[]
}

export interface ToolFunc {
  name: string
  description: string
  parameters: ToolParam
}

export interface ToolDef {
  type: 'function'
  function: ToolFunc
}

export const toolDefs: ToolDef[] = [
  { type: 'function', function: { name: 'listInstances', description: '列出所有 Minecraft 游戏实例', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'getInstance', description: '获取指定游戏实例的详细信息', parameters: { type: 'object', properties: { instanceId: { type: 'string', description: '实例 ID' } }, required: ['instanceId'] } } },
  { type: 'function', function: { name: 'getInstanceLaunchProgress', description: '查询实例的启动进度', parameters: { type: 'object', properties: { instanceId: { type: 'string', description: '实例 ID' } }, required: ['instanceId'] } } },
  { type: 'function', function: { name: 'createInstance', description: '创建新的 Minecraft 游戏实例。创建后需要调用 installInstance 来安装 Minecraft 版本和加载器', parameters: { type: 'object', properties: { name: { type: 'string', description: '实例名称' }, gameVersion: { type: 'string', description: 'Minecraft 版本号' }, loader: { type: 'string', description: '加载器类型: fabric/forge/neoforge/quilt' }, loaderVersion: { type: 'string', description: '加载器版本号' }, javaPath: { type: 'string', description: 'Java 路径（可选）' }, maxMemory: { type: 'integer', description: '最大内存 MB' }, gameDir: { type: 'string', description: '游戏目录' } }, required: ['name', 'gameVersion', 'loader', 'loaderVersion'] } } },
  { type: 'function', function: { name: 'launchInstance', description: '启动指定实例', parameters: { type: 'object', properties: { instanceId: { type: 'string', description: '实例 ID' }, accountUuid: { type: 'string', description: '账号 UUID' }, joinServer: { type: 'string', description: '快捷加入服务器地址' }, joinWorld: { type: 'string', description: '快捷加入世界名' } }, required: ['instanceId'] } } },
  { type: 'function', function: { name: 'installInstance', description: '触发实例安装', parameters: { type: 'object', properties: { instanceId: { type: 'string' }, loader: { type: 'string' }, loaderVersion: { type: 'string' }, addons: { type: 'array', items: { type: 'string' } }, optifineVersion: { type: 'string' }, versionIsolation: { type: 'boolean' }, downloadThreads: { type: 'integer' } }, required: ['instanceId', 'loader', 'loaderVersion'] } } },
  { type: 'function', function: { name: 'searchResources', description: '跨平台搜索 Minecraft 资源', parameters: { type: 'object', properties: { keyword: { type: 'string' }, source: { type: 'string', description: 'modrinth/curseforge/ftb' }, page: { type: 'integer' }, pageSize: { type: 'integer' }, gameVersion: { type: 'string' }, loader: { type: 'string' }, category: { type: 'string' }, sort: { type: 'string' } }, required: ['keyword'] } } },
  { type: 'function', function: { name: 'getResourceDetail', description: '获取资源详细信息', parameters: { type: 'object', properties: { id: { type: 'string' }, source: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'getResourceVersions', description: '获取资源可用版本列表', parameters: { type: 'object', properties: { id: { type: 'string' }, source: { type: 'string' }, gameVersion: { type: 'string' }, loader: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'getVersionDownloads', description: '获取资源版本的下载链接', parameters: { type: 'object', properties: { id: { type: 'string' }, versionId: { type: 'string' }, source: { type: 'string' } }, required: ['id', 'versionId'] } } },
  { type: 'function', function: { name: 'getResourceDependencies', description: '获取资源依赖树', parameters: { type: 'object', properties: { id: { type: 'string' }, source: { type: 'string' }, versionId: { type: 'string' }, gameVersion: { type: 'string' }, loader: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'startDownload', description: '开始下载资源到指定实例', parameters: { type: 'object', properties: { instanceId: { type: 'string' }, url: { type: 'string' }, fileName: { type: 'string' }, category: { type: 'string' } }, required: ['instanceId', 'url', 'fileName', 'category'] } } },
  { type: 'function', function: { name: 'getDownloadProgress', description: '查询下载进度', parameters: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] } } },
  { type: 'function', function: { name: 'installMod', description: '自动搜索并安装模组到指定实例', parameters: { type: 'object', properties: { keyword: { type: 'string' }, instanceId: { type: 'string' }, gameVersion: { type: 'string' }, loader: { type: 'string' }, source: { type: 'string' } }, required: ['keyword', 'instanceId'] } } },
  { type: 'function', function: { name: 'listMods', description: '列出指定实例的模组文件', parameters: { type: 'object', properties: { instanceId: { type: 'string' } }, required: ['instanceId'] } } },
  { type: 'function', function: { name: 'getModMetadata', description: '获取模组元数据', parameters: { type: 'object', properties: { instanceId: { type: 'string' } }, required: ['instanceId'] } } },
  { type: 'function', function: { name: 'enableDisableMod', description: '启用/禁用模组', parameters: { type: 'object', properties: { instanceId: { type: 'string' }, name: { type: 'string' }, enable: { type: 'boolean' } }, required: ['instanceId', 'name', 'enable'] } } },
  { type: 'function', function: { name: 'listResourcepacks', description: '列出资源包列表', parameters: { type: 'object', properties: { instanceId: { type: 'string' } }, required: ['instanceId'] } } },
  { type: 'function', function: { name: 'listShaderpacks', description: '列出光影包列表', parameters: { type: 'object', properties: { instanceId: { type: 'string' } }, required: ['instanceId'] } } },
  { type: 'function', function: { name: 'listScreenshots', description: '列出截图列表', parameters: { type: 'object', properties: { instanceId: { type: 'string' } }, required: ['instanceId'] } } },
  { type: 'function', function: { name: 'getLanGames', description: '发现局域网游戏', parameters: { type: 'object', properties: { instanceId: { type: 'string' } }, required: ['instanceId'] } } },
  { type: 'function', function: { name: 'getSystemInfo', description: '获取系统和启动器信息', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'getLauncherSettings', description: '获取启动器设置', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'getConnectorStatus', description: '获取联机状态', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'checkHealth', description: '检查后端服务', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'listPlugins', description: '列出已安装插件', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'listLogs', description: '列出日志文件', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'parseModpack', description: '解析整合包文件', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'sendNotification', description: '发送通知', parameters: { type: 'object', properties: { message: { type: 'string' }, type: { type: 'string', enum: ['info', 'success', 'error'] } }, required: ['message'] } } },
  { type: 'function', function: { name: 'navigateTo', description: '导航到页面', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'callBackendApi', description: '通用后端 API 调用', parameters: { type: 'object', properties: { method: { type: 'string', enum: ['GET', 'POST'] }, endpoint: { type: 'string' }, data: { type: 'string' } }, required: ['method', 'endpoint'] } } },
]

export async function handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'listInstances': return callBackend('/instance')
    case 'getInstance': return callBackend(`/instance/${args.instanceId}`)
    case 'getInstanceLaunchProgress': return callBackend(`/instance/${args.instanceId}/launch/progress`)
    case 'createInstance': return callBackend('/instance', {
      name: args.name, gameVersion: args.gameVersion, loader: args.loader,
      loaderVersion: args.loaderVersion, javaPath: args.javaPath || null,
      maxMemory: args.maxMemory || 4096, gameDir: args.gameDir || '.minecraft'
    })
    case 'installInstance': return callBackend(`/instance/${args.instanceId}/install`, {
      loader: args.loader, loaderVersion: args.loaderVersion,
      addons: args.addons || undefined, optifineVersion: args.optifineVersion || undefined,
      versionIsolation: args.versionIsolation !== undefined ? args.versionIsolation : true,
      downloadThreads: args.downloadThreads || 64, downloadSourceId: 0, downloadTimeout: 15
    })
    case 'launchInstance': {
      const body: Record<string, unknown> = {}
      if (args.accountUuid) body.accountUuid = args.accountUuid
      if (args.joinServer) body.joinServer = args.joinServer
      if (args.joinWorld) body.joinWorld = args.joinWorld
      const r = await callBackend<{ stage?: string; message?: string }>(`/instance/${args.instanceId}/launch`, body)
      const result: Record<string, unknown> = { launched: true, stage: r.stage || 'starting', message: r.message || '启动中' }
      return new Promise(resolve => {
        let polls = 0
        function poll() {
          callBackend<{ stage: string; message: string; progress?: unknown; processId?: unknown; isRunning?: boolean; error?: string; crashReport?: unknown }>(`/instance/${args.instanceId}/launch/progress`)
            .then(p => {
              result.stage = p.stage; result.message = p.message; result.progress = p.progress; result.processId = p.processId
              if (p.isRunning || p.stage === 'running') { result.status = 'running'; resolve(result); return }
              if (p.stage === 'failed' || p.stage === 'crashed') { result.status = p.stage; result.error = p.error || p.crashReport; resolve(result); return }
              if (p.stage === 'completed') { result.status = 'completed'; resolve(result); return }
              polls++
              if (polls < 20) setTimeout(poll, 1000)
              else { result.status = '启动中（后台）'; resolve(result) }
            }).catch(() => resolve(result))
        }
        setTimeout(poll, 500)
      })
    }
    case 'searchResources': {
      const p = new URLSearchParams({ keyword: String(args.keyword) })
      if (args.source) p.set('source', String(args.source))
      if (args.page) p.set('page', String(args.page))
      if (args.pageSize) p.set('pageSize', String(args.pageSize))
      if (args.gameVersion) p.set('gameVersion', String(args.gameVersion))
      if (args.loader) p.set('loader', String(args.loader))
      if (args.category) p.set('category', String(args.category))
      if (args.sort) p.set('sort', String(args.sort))
      return callBackend(`/resources/search?${p}`)
    }
    case 'getResourceDetail': return callBackend(`/resources/${args.id}?source=${args.source || 'modrinth'}`)
    case 'getResourceVersions': {
      const p = new URLSearchParams({ source: String(args.source || 'modrinth') })
      if (args.gameVersion) p.set('gameVersion', String(args.gameVersion))
      if (args.loader) p.set('loader', String(args.loader))
      return callBackend(`/resources/${args.id}/versions?${p}`)
    }
    case 'getVersionDownloads': return callBackend(`/resources/${args.id}/versions/${args.versionId}/downloads?source=${args.source || 'modrinth'}`)
    case 'getResourceDependencies': {
      const p = new URLSearchParams({ source: String(args.source || 'modrinth') })
      if (args.versionId) p.set('versionId', String(args.versionId))
      if (args.gameVersion) p.set('gameVersion', String(args.gameVersion))
      if (args.loader) p.set('loader', String(args.loader))
      return callBackend(`/resources/${args.id}/dependencies?${p}`)
    }
    case 'startDownload': return callBackend('/resource-download/start', {
      instanceId: args.instanceId, url: args.url, fileName: args.fileName, category: args.category
    })
    case 'installMod': {
      const inst = await callBackend<{ gameVersion?: string; loader?: string }>(`/instance/${args.instanceId}`)
      const gv = args.gameVersion || inst.gameVersion
      const ld = args.loader || inst.loader || ''
      const src = String(args.source || 'modrinth')
      const searchRes = await callBackend<{ items?: unknown[]; data?: unknown[] }>(`/resources/search?source=${src}&keyword=${encodeURIComponent(String(args.keyword))}&category=mod&pageSize=5`)
      const items = searchRes.items || searchRes.data || []
      if (items.length === 0) return { error: '未找到匹配的模组' }
      const mod = items[0] as Record<string, string>
      const id = mod.id || mod.projectId
      const detail = await callBackend<Record<string, unknown>>(`/resources/${id}?source=${src}`)
      const versions = await callBackend<unknown[]>('/resources/' + id + '/versions?source=' + src + '&gameVersion=' + encodeURIComponent(String(gv)) + '&loader=' + encodeURIComponent(String(ld)))
      if (!versions || (versions as unknown[]).length === 0) return { error: `没有兼容 ${gv} ${ld} 的版本`, modName: mod.title || mod.name, matchedCount: items.length }
      const ver = (versions as Record<string, string>[])[0]
      const verId = ver.id || ver.versionId
      const downloads = await callBackend<unknown[]>(`/resources/${id}/versions/${verId}/downloads?source=${src}`)
      const files = downloads || []
      if (files.length === 0) return { error: '没有可下载的文件', version: verId }
      const deps = await callBackend<unknown[]>('/resources/' + id + '/dependencies?source=' + src + '&versionId=' + verId + '&gameVersion=' + encodeURIComponent(String(gv)) + '&loader=' + encodeURIComponent(String(ld))).catch(() => [])
      const results: Record<string, unknown>[] = []
      for (const f of files as Record<string, string>[]) {
        const fn = f.fileName || f.filename || (mod.title || mod.name) + '.jar'
        const dl = await callBackend<Record<string, unknown>>('/resource-download/start', { instanceId: args.instanceId, url: f.url, fileName: fn, category: 'mods' }).catch((e: Error) => ({ error: e.message, taskId: null }))
        results.push({ file: fn, taskId: (dl as Record<string, unknown>).taskId || null, error: (dl as Record<string, unknown>).error || null })
      }
      if (deps && deps.length > 0) {
        for (let d = 0; d < Math.min(deps.length, 5); d++) {
          const dep = (deps as Record<string, string>[])[d]
          const depUrl = dep.downloadUrl || dep.url
          const depFn = dep.fileName || dep.name || `dependency-${d}.jar`
          if (depUrl) {
            const dl2 = await callBackend<Record<string, unknown>>('/resource-download/start', { instanceId: args.instanceId, url: depUrl, fileName: depFn, category: 'mods' }).catch(() => ({ taskId: null } as Record<string, unknown>))
            results.push({ file: depFn + ' (依赖)', taskId: (dl2 as Record<string, unknown>).taskId || null })
          }
        }
      }
      return { modName: mod.title || mod.name, version: ver.name || verId, matchedCount: items.length, downloads: results, dependencies: (deps || []).length }
    }
    case 'getDownloadProgress': return callBackend(`/resource-download/${args.taskId}/progress`)
    case 'listMods': return callBackend(`/instance/${args.instanceId}/files/mods`)
    case 'getModMetadata': return callBackend(`/instance/${args.instanceId}/files/mods/metadata`)
    case 'enableDisableMod': {
      const action = args.enable ? 'enable' : 'disable'
      return callBackend(`/instance/${args.instanceId}/files/mods/${action}?name=${encodeURIComponent(String(args.name))}`, {})
    }
    case 'listResourcepacks': return callBackend(`/instance/${args.instanceId}/files/resourcepacks`)
    case 'listShaderpacks': return callBackend(`/instance/${args.instanceId}/files/shaderpacks`)
    case 'listScreenshots': return callBackend(`/instance/${args.instanceId}/files/screenshots`)
    case 'getLanGames': return callBackend(`/instance/${args.instanceId}/files/lan-games`)
    case 'getSystemInfo': return callBackend('/system/info')
    case 'getLauncherSettings': return callBackend('/settings')
    case 'getConnectorStatus': return callBackend('/connector/status')
    case 'checkHealth': return callBackend('/health')
    case 'listPlugins': return callBackend('/plugins')
    case 'listLogs': return callBackend('/logs')
    case 'parseModpack': return { error: 'parseModpack 需要上传文件，请通过启动器界面手动操作' }
    case 'sendNotification': showToast(String(args.message), (args.type as 'info' | 'success' | 'error') || 'info'); return { success: true }
    case 'navigateTo': {
      const path = String(args.path)
      await apiCall<unknown>('navigate', path)
      return { success: true, path }
    }
    case 'callBackendApi': {
      if (args.method === 'GET') return callBackend(String(args.endpoint))
      return callBackend(String(args.endpoint), args.data ? JSON.parse(String(args.data)) : undefined)
    }
    default: return { error: `unknown tool: ${name}` }
  }
}

function apiCall<T>(method: string, ...args: unknown[]): Promise<T> {
  if (!window.__PLUGIN_API__) throw new Error('API not initialized')
  return window.__PLUGIN_API__.call(method, ...args) as Promise<T>
}
