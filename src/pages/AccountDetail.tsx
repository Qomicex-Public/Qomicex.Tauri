import { useEffect, useState, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faArrowLeft, faRotate, faTrashCan, faUpload, faUndo, faGlobe, faDownload, faShirt } from '@fortawesome/free-solid-svg-icons'
import { getAccount, deleteAccount } from '../api/account.ts'
import { getSkinProfile, uploadSkin, resetSkin, saveSkinTo, getCapeBlobUrl, getMcCapes, getMcCapeImageUrl, equipMcCape, unequipMcCape, invalidateAvatarCache } from '../api/skin.ts'
import { save } from '@tauri-apps/plugin-dialog'
import { API_BASE } from '../api/client.ts'
import { openUrl } from '@tauri-apps/plugin-opener'
import { SkinViewer3D } from '../components/SkinViewer3D.tsx'
import { CapeManageDialog } from '../components/CapeManageDialog.tsx'
import { useMessageBox } from '../components/ui'
import { Button } from '../components/ui'
import { PageShell } from '../components/PageShell.tsx'
import { capeDisplayName } from '../lib/cape-names.ts'
import type { Account, SkinProfile, McCape } from '../types/index.ts'

export default function AccountDetail() {
  const { uuid } = useParams<{ uuid: string }>()
  const navigate = useNavigate()
  const { confirm: msgConfirm, notify } = useMessageBox()
  const [account, setAccount] = useState<Account | null>(null)
  const [profile, setProfile] = useState<SkinProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [showNameTag, setShowNameTag] = useState(true)
  const [showCape, setShowCape] = useState(true)
  const [capeUrl, setCapeUrl] = useState<string | null>(null)
  const [mcCapes, setMcCapes] = useState<McCape[]>([])
  const [capeImages, setCapeImages] = useState<Map<string, string>>(new Map())
  const [capeBusy, setCapeBusy] = useState(false)
  const [capeDialogOpen, setCapeDialogOpen] = useState(false)
  const [skinVersion, setSkinVersion] = useState(0)
  const [skinModel, setSkinModel] = useState<'slim' | 'classic'>('classic')
  const capeImagesRef = useRef<Map<string, string>>(new Map())
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!uuid) return
    setLoading(true)
    getAccount(uuid).then((acc) => {
      setAccount(acc)
      setLoading(false)
      getSkinProfile(uuid, acc?.loginMethod ?? 'Microsoft', acc?.serverUrl).then((prof) => setProfile(prof)).catch(() => {})
    }).catch(() => setLoading(false))
  }, [uuid])

  const textureUrl = `${API_BASE}/skin/texture/${uuid}?type=${account?.loginMethod ?? 'Microsoft'}${account?.serverUrl ? `&server=${encodeURIComponent(account.serverUrl)}` : ''}&t=${skinVersion}`

  // 披风图源：非微软 → /skin/cape（profile capeUrl）；微软 → mcCapes 的 ACTIVE 披风裁剪图（见下方）。
  useEffect(() => {
    if (!uuid || !account || account.loginMethod === 'Microsoft') return
    let cancelled = false
    getCapeBlobUrl(uuid, account.loginMethod, account.serverUrl).then((url) => {
      if (!cancelled) setCapeUrl(url)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [uuid, account?.loginMethod, account?.serverUrl])

  // 微软披风列表 + 缩略图加载
  async function loadMcCapes() {
    if (!uuid || account?.loginMethod !== 'Microsoft') return
    setCapeBusy(true)
    try {
      const capes = await getMcCapes(uuid)
      setMcCapes(capes)
      const entries = await Promise.all(
        capes.map(async (c) => [c.id, await getMcCapeImageUrl(uuid, c.id)] as const),
      )
      const next = new Map(entries.filter(([, url]) => url) as [string, string][])
      for (const url of capeImagesRef.current.values()) URL.revokeObjectURL(url)
      capeImagesRef.current = next
      setCapeImages(next)
    } catch {
      setMcCapes([])
    } finally {
      setCapeBusy(false)
    }
  }

  useEffect(() => {
    loadMcCapes()
  }, [uuid, account?.loginMethod])

  // 打开披风管理弹窗时刷新披风列表
  useEffect(() => {
    if (capeDialogOpen) loadMcCapes()
  }, [capeDialogOpen])

  // 卸载时释放披风 blob URL
  useEffect(() => () => {
    for (const url of capeImagesRef.current.values()) URL.revokeObjectURL(url)
  }, [])

  // 微软：3D viewer 披风源 = 当前 ACTIVE 披风的裁剪图
  const activeCape = mcCapes.find((c) => c.state === 'ACTIVE') ?? null
  useEffect(() => {
    if (!uuid || !account || account.loginMethod !== 'Microsoft') return
    setCapeUrl(activeCape ? (capeImages.get(activeCape.id) ?? null) : null)
  }, [mcCapes, capeImages])

  async function handleCapeToggle(cape: McCape) {
    if (!uuid || capeBusy) return
    setCapeBusy(true)
    try {
      if (cape.state === 'ACTIVE') {
        await unequipMcCape(uuid, cape.id)
        notify('披风已卸下', 'success')
      } else {
        await equipMcCape(uuid, cape.id)
        notify('披风已装备', 'success')
      }
      await loadMcCapes()
    } catch {
      notify('披风切换失败，请重新登录后重试', 'error')
    } finally {
      setCapeBusy(false)
    }
  }

  async function handleSkinRefresh() {
    if (!uuid) return
    invalidateAvatarCache()
    const prof = await getSkinProfile(uuid, account?.loginMethod ?? 'Microsoft', account?.serverUrl).catch(() => null)
    setProfile(prof)
    setSkinVersion((v) => v + 1)
  }

  async function handleSkinUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !uuid) return
    try {
      await uploadSkin(uuid, file, account?.loginMethod ?? 'Microsoft', account?.serverUrl, skinModel)
      notify('皮肤上传成功', 'success')
      handleSkinRefresh()
    } catch { notify('皮肤上传失败', 'error') }
    if (fileRef.current) fileRef.current.value = ''
  }

  async function handleSkinReset() {
    if (!uuid) return
    const ok = await msgConfirm('确定要重置为默认皮肤吗？')
    if (!ok) return
    try {
      await resetSkin(uuid, account?.loginMethod ?? 'Microsoft', account?.serverUrl)
      notify('皮肤已重置', 'success')
      handleSkinRefresh()
    } catch { notify('皮肤重置失败', 'error') }
  }

  async function handleSkinDownload() {
    if (!uuid) return
    try {
      // Desktop (Tauri): native "另存为" dialog, backend writes the file.
      const dest = await save({ defaultPath: `${account?.name ?? uuid}.png`, filters: [{ name: 'PNG', extensions: ['png'] }] })
      if (!dest) return
      await saveSkinTo(uuid, dest, account?.loginMethod ?? 'Microsoft', account?.serverUrl)
      notify(`皮肤已保存到 ${dest}`, 'success')
      return
    } catch { /* not in Tauri — fall back to browser download */ }
    try {
      const resp = await fetch(`${textureUrl}&download=1`)
      if (!resp.ok) throw new Error('下载失败')
      const blob = await resp.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${account?.name ?? uuid}.png`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      notify('皮肤已下载', 'success')
    } catch { notify('皮肤下载失败', 'error') }
  }

  async function handleDelete() {
    if (!uuid) return
    const ok = await msgConfirm('确定要删除此账户吗？')
    if (!ok) return
    await deleteAccount(uuid)
    navigate('/accounts')
  }

  if (loading || !account) {
    return <div className="flex flex-1 h-full items-center justify-center overflow-y-auto text-muted-foreground">加载中...</div>
  }

  return (
    <PageShell className="space-y-6 p-8 overflow-y-auto scroll-fade-mask">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('/accounts')}>
          <FontAwesomeIcon icon={faArrowLeft} className="h-4 w-4" />
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">{account.name}</h1>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-1">
            <div className="flex flex-col items-center gap-3 rounded-xl border bg-card p-6">
              <SkinViewer3D textureUrl={textureUrl} model={profile?.model === 'slim' ? 'slim' : 'classic'} width={280} height={380} className="rounded-lg" name={account.name} showNameTag={showNameTag} panoramaUrl="/panorama.png" capeUrl={capeUrl} showCape={showCape} />
              <div className="flex flex-wrap items-center justify-center gap-4">
                <button onClick={() => setShowNameTag(v => !v)} className={`flex items-center gap-2 text-xs ${showNameTag ? 'text-primary' : 'text-muted-foreground'}`}>
                  <div className={`h-3.5 w-7 rounded-full p-0.5 transition-colors ${showNameTag ? 'bg-primary' : 'bg-input'}`}>
                    <div className={`h-2.5 w-2.5 rounded-full bg-background transition-transform ${showNameTag ? 'translate-x-3' : ''}`} />
                  </div>
                  显示名称标签
                </button>
                <button onClick={() => setShowCape(v => !v)} disabled={!capeUrl} className={`flex items-center gap-2 text-xs ${showCape && capeUrl ? 'text-primary' : 'text-muted-foreground'} ${!capeUrl ? 'opacity-40' : ''}`}>
                  <div className={`h-3.5 w-7 rounded-full p-0.5 transition-colors ${showCape && capeUrl ? 'bg-primary' : 'bg-input'}`}>
                    <div className={`h-2.5 w-2.5 rounded-full bg-background transition-transform ${showCape && capeUrl ? 'translate-x-3' : ''}`} />
                  </div>
                   显示披风
                </button>
                <Button variant="ghost" size="sm" onClick={handleSkinDownload} className="text-xs">
                  <FontAwesomeIcon icon={faDownload} className="h-3.5 w-3.5" />
                  下载皮肤
                </Button>

              </div>
            </div>
        </div>

        <div className="space-y-4 lg:col-span-2">
          <div className="rounded-xl border bg-card p-5">
            <h2 className="mb-3 text-sm font-semibold">账户信息</h2>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">名称</dt>
                <dd>{account.name}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">UUID</dt>
                <dd className="font-mono text-xs">{account.uuid}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">类型</dt>
                <dd>{account.loginMethod}</dd>
              </div>
              {account.serverUrl && (
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">验证服务器</dt>
                  <dd className="text-xs">{account.serverUrl}</dd>
                </div>
              )}
              {profile && (
                <>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">皮肤模型</dt>
                    <dd>{profile.model === 'slim' ? '纤细 (Slim)' : '经典 (Classic)'}</dd>
                  </div>
                  {account.loginMethod === 'Microsoft' ? (
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">披风</dt>
                      <dd>{activeCape ? capeDisplayName(activeCape.id, activeCape.alias) : '无'}</dd>
                    </div>
                  ) : profile.capeUrl ? (
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">披风</dt>
                      <dd>有</dd>
                    </div>
                  ) : null}
                </>
              )}
            </dl>
          </div>

          <div className="flex gap-2 flex-wrap">
            <Button variant="outline" size="sm" onClick={handleSkinRefresh}>
              <FontAwesomeIcon icon={faRotate} className="mr-1 h-3 w-3" /> 刷新皮肤
            </Button>
            {account.loginMethod === 'Microsoft' ? (
              <>
                <Button variant="outline" size="sm" onClick={() => setCapeDialogOpen(true)}>
                  <FontAwesomeIcon icon={faShirt} className="mr-1 h-3 w-3" /> 切换披风
                </Button>
                <div className="flex items-center gap-1 rounded-md border bg-input/50 px-2 py-1 text-xs">
                  <span className="text-muted-foreground">手臂模型</span>
                  <button
                    onClick={() => setSkinModel('classic')}
                    className={`rounded px-1.5 py-0.5 ${skinModel === 'classic' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
                  >经典</button>
                  <button
                    onClick={() => setSkinModel('slim')}
                    className={`rounded px-1.5 py-0.5 ${skinModel === 'slim' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
                  >纤细</button>
                </div>
                <input ref={fileRef} type="file" accept="image/png" className="hidden" onChange={handleSkinUpload} />
                <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                  <FontAwesomeIcon icon={faUpload} className="mr-1 h-3 w-3" /> 上传皮肤
                </Button>
                {profile?.skinSource === 'local' && (
                  <Button variant="outline" size="sm" onClick={handleSkinReset}>
                    <FontAwesomeIcon icon={faUndo} className="mr-1 h-3 w-3" /> 重置皮肤
                  </Button>
                )}
              </>
            ) : account.serverUrl ? (
              <Button variant="outline" size="sm" onClick={() => { const url = new URL(account.serverUrl!).origin; openUrl(url).catch(() => window.open(url, '_blank')) }}>
                <FontAwesomeIcon icon={faGlobe} className="mr-1 h-3 w-3" /> 前往皮肤站
              </Button>
            ) : null}
            <Button variant="destructive" size="sm" onClick={handleDelete}>
              <FontAwesomeIcon icon={faTrashCan} className="mr-1 h-3 w-3" /> 删除账户
            </Button>
          </div>
        </div>
      </div>
      <CapeManageDialog
        open={capeDialogOpen}
        onClose={() => setCapeDialogOpen(false)}
        mcCapes={mcCapes}
        capeImages={capeImages}
        capeBusy={capeBusy}
        onToggle={handleCapeToggle}
      />
    </PageShell>
  )
}
