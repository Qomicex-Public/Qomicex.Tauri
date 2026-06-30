### Task 9: 重写 ModsTab 组件

**Files:**
- Modify: `src/pages/InstanceDetail.tsx`

**Interfaces:**
- Consumes: `ModMetadata` (Task 4); `getModsMetadata`, `batchEnableMods`, `batchDisableMods`, `batchDeleteMods` (Task 5); `ModCard` (Task 7); `VersionPickerDialog` (Task 8)
- Produces: 替换现有 `ModsTab` 函数

- [ ] **Step 1: 更新 imports**

在 InstanceDetail.tsx 顶部修改导入行。找到第 19 行的 `import { getSaves, ... } from '../api/instance-files.ts'`，将 `getMods, deleteMod` 替换为 `getModsMetadata, batchEnableMods, batchDisableMods, batchDeleteMods`：

```tsx
import { getSaves, getScreenshots, getResourcePacks, getShaderPacks, getServers, deleteSave, copySave, deleteScreenshot, deleteResourcePack, deleteShaderPack, addServer, deleteServer, pingServer, getModsMetadata, batchEnableMods, batchDisableMods, batchDeleteMods } from '../api/instance-files.ts'
```

然后在其他 import 区域添加新导入：

```tsx
import ModCard from '../components/ModCard.tsx'
import VersionPickerDialog from '../components/VersionPickerDialog.tsx'
import type { ModMetadata } from '../types/index.ts'
```

- [ ] **Step 2: 重写 ModsTab 函数**

找到 `function ModsTab({ instanceId, files, loading, onRefresh, gameVersion, loader }: { ... })`（约第 204 行），完整替换为：

```tsx
function ModsTab({ instanceId, gameVersion, loader }: {
  instanceId: string
  gameVersion?: string
  loader?: string
}) {
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [mods, setMods] = useState<ModMetadata[]>([])
  const [loading, setLoading] = useState(true)
  const [versionDialogMod, setVersionDialogMod] = useState<ModMetadata | null>(null)

  const [batchMode, setBatchMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [batchConfirm, setBatchConfirm] = useState<{ type: 'enable' | 'disable' | 'delete' } | null>(null)
  const [batchProcessing, setBatchProcessing] = useState(false)

  const loadMods = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getModsMetadata(instanceId)
      setMods(data)
    } catch { setMods([]) }
    setLoading(false)
  }, [instanceId])

  useEffect(() => {
    loadMods()
  }, [loadMods])

  const filtered = useMemo(() => {
    if (!search) return mods
    const q = search.toLowerCase()
    return mods.filter(m =>
      m.name.toLowerCase().includes(q) ||
      (m.chineseName && m.chineseName.includes(q)) ||
      m.fileName.toLowerCase().includes(q)
    )
  }, [mods, search])

  const toggleSelect = useCallback((fileName: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(fileName)) next.delete(fileName)
      else next.add(fileName)
      return next
    })
  }, [])

  const enterBatchMode = useCallback(() => {
    setBatchMode(true)
    setSelected(new Set())
  }, [])

  const exitBatchMode = useCallback(() => {
    setBatchMode(false)
    setSelected(new Set())
  }, [])

  const handleBatchAction = useCallback(async () => {
    if (!batchConfirm) return
    setBatchProcessing(true)
    const names = Array.from(selected)
    try {
      if (batchConfirm.type === 'enable') await batchEnableMods(instanceId, names)
      else if (batchConfirm.type === 'disable') await batchDisableMods(instanceId, names)
      else if (batchConfirm.type === 'delete') await batchDeleteMods(instanceId, names)
      await loadMods()
      exitBatchMode()
    } catch {}
    setBatchProcessing(false)
    setBatchConfirm(null)
  }, [batchConfirm, selected, instanceId, loadMods, exitBatchMode])

  if (!loader) {
    return (
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <FontAwesomeIcon icon={faCube} className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-medium">Mod 管理</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">该实例不可使用 Mod，需要使用 Forge、Fabric 等加载器</p>
            </div>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <>
      <Card>
        <CardContent className="p-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium shrink-0">
              <FontAwesomeIcon icon={faCube} className="mr-2 h-4 w-4 text-primary" />Mod
              {mods.length > 0 && <span className="ml-1.5 text-xs font-normal text-muted-foreground">({mods.length})</span>}
            </h3>
            <div className="flex items-center gap-2 flex-1 max-w-sm">
              <div className="relative flex-1">
                <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索 Mod..." className="h-8 pl-8 text-xs" />
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              {batchMode ? (
                <>
                  <Button size="sm" variant="outline" onClick={exitBatchMode} className="gap-1.5 h-7 text-xs">取消</Button>
                  <Button size="sm" variant="outline" onClick={() => setBatchConfirm({ type: 'enable' })} disabled={selected.size === 0} className="gap-1.5 h-7 text-xs">启用</Button>
                  <Button size="sm" variant="outline" onClick={() => setBatchConfirm({ type: 'disable' })} disabled={selected.size === 0} className="gap-1.5 h-7 text-xs">禁用</Button>
                  <Button size="sm" variant="outline" onClick={() => setBatchConfirm({ type: 'delete' })} disabled={selected.size === 0} className="gap-1.5 h-7 text-xs text-destructive hover:text-destructive">删除</Button>
                </>
              ) : (
                <>
                  <Button size="sm" variant="ghost" onClick={() => {/* open mods folder */}} className="gap-1.5 h-7 text-xs">
                    <FontAwesomeIcon icon={faFolderOpen} className="h-3.5 w-3.5" />打开文件夹
                  </Button>
                  <Button size="sm" onClick={() => {
                    const p = new URLSearchParams({ category: 'mod', source: 'modrinth' })
                    if (gameVersion) p.set('gameVersion', gameVersion)
                    if (loader) p.set('loader', loader.toLowerCase())
                    if (instanceId) p.set('instanceId', instanceId)
                    navigate(`/resource-center?${p.toString()}`)
                  }} className="gap-1.5 h-7 text-xs">
                    <FontAwesomeIcon icon={faDownload} className="h-3.5 w-3.5" />安装 Mod
                  </Button>
                </>
              )}
            </div>
          </div>

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <FontAwesomeIcon icon={faRotate} className="h-4 w-4 animate-spin" />加载中...
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {search ? '无匹配 Mod' : '暂无 Mod'}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {filtered.map((mod) => (
                <ModCard
                  key={mod.fileName}
                  mod={mod}
                  instanceId={instanceId}
                  gameVersion={gameVersion}
                  loader={loader}
                  onRefresh={loadMods}
                  onChangeVersion={setVersionDialogMod}
                  batchMode={batchMode}
                  selected={selected.has(mod.fileName)}
                  onSelect={toggleSelect}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={batchConfirm !== null} onClose={() => setBatchConfirm(null)}>
        <DialogHeader onClose={() => setBatchConfirm(null)}>
          <DialogTitle>
            {batchConfirm?.type === 'enable' ? '批量启用' : batchConfirm?.type === 'disable' ? '批量禁用' : '批量删除'}
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm text-muted-foreground">
            确定要
            {batchConfirm?.type === 'enable' ? '启用' : batchConfirm?.type === 'disable' ? '禁用' : '删除'}
            {selected.size} 个 Mod 吗？
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setBatchConfirm(null)}>取消</Button>
          <Button size="sm" variant={batchConfirm?.type === 'delete' ? 'destructive' : 'default'} onClick={handleBatchAction} disabled={batchProcessing}>
            {batchProcessing ? '处理中...' : '确定'}
          </Button>
        </DialogFooter>
      </Dialog>

      <VersionPickerDialog
        open={versionDialogMod !== null}
        onClose={() => setVersionDialogMod(null)}
        mod={versionDialogMod}
        instanceId={instanceId}
        gameVersion={gameVersion}
        loader={loader}
        onDone={loadMods}
      />
    </>
  )
}
```

- [ ] **Step 3: 更新 ModsTab 调用**

在 InstanceDetailPage 底部（约第 975 行），找到 ModsTab 的调用：

```tsx
{tab === 'mods' && <ModsTab instanceId={id!} files={fileData['mods'] as FileEntry[] | null} loading={fileLoading['mods']} onRefresh={() => loadFiles('mods')} gameVersion={instance.gameVersion} loader={instance.loader || undefined} />}
```

替换为：

```tsx
{tab === 'mods' && <ModsTab instanceId={id!} gameVersion={instance.gameVersion} loader={instance.loader || undefined} />}
```

- [ ] **Step 4: 类型检查**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/pages/InstanceDetail.tsx
git commit -m "feat: rewrite ModsTab with metadata cards, context menu, batch ops"
```
