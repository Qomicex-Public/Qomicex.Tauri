import { useEffect, useState, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faArrowLeft, faRotate, faTrashCan, faUpload, faUndo, faGlobe, faDownload, faShirt } from '@fortawesome/free-solid-svg-icons'
import { getAccount, deleteAccount } from '../api/account.ts'
import { getSkinProfile, uploadSkin, resetSkin, saveSkinTo, getCapeBlobUrl, getMcCapes, getMcCapeImageUrl, equipMcCape, unequipMcCape, invalidateAvatarCache } from '../api/skin.ts'
import { save } from '@tauri-apps/plugin-dialog'
import { API_BASE, ApiError } from '../api/client.ts'
import { openUrl } from '@tauri-apps/plugin-opener'
import { SkinViewer3D } from '../components/SkinViewer3D.tsx'
import { CapeManageDialog } from '../components/CapeManageDialog.tsx'
import { MicrosoftReauthDialog } from '../components/MicrosoftReauthDialog.tsx'
import { useMessageBox } from '../components/ui'
import { Button, Dialog, DialogHeader, DialogTitle, DialogBody } from '../components/ui'
import { PageShell } from '../components/PageShell.tsx'
import { capeDisplayName } from '../lib/cape-names.ts'
import { useI18n } from '../i18n/index.tsx'
import type { Account, SkinProfile, McCape } from '../types/index.ts'

// 后端 skin 端点已先自动续期；走到这两种错误说明 refresh_token 失效或断网
function isMicrosoftAuthError(e: unknown): boolean {
  return e instanceof ApiError && (e.code === 'TOKEN_EXPIRED' || e.code === 'NETWORK_ERROR')
}

export default function AccountDetail() {
  const { uuid } = useParams<{ uuid: string }>()
  const navigate = useNavigate()
  const { confirm: msgConfirm, notify } = useMessageBox()
  const { t, lang } = useI18n()
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
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [modelDialogOpen, setModelDialogOpen] = useState(false)
  const [showMicrosoftReauth, setShowMicrosoftReauth] = useState(false)
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
    } catch (e) {
      if (isMicrosoftAuthError(e)) setShowMicrosoftReauth(true)
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
        notify(t('accountDetail.capeUnequipped'), 'success')
      } else {
        await equipMcCape(uuid, cape.id)
        notify(t('accountDetail.capeEquipped'), 'success')
      }
      await loadMcCapes()
    } catch (e) {
      if (isMicrosoftAuthError(e)) { setShowMicrosoftReauth(true); return }
      notify(t('accountDetail.capeSwitchFailed'), 'error')
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
    setPendingFile(file)
    setModelDialogOpen(true)
    if (fileRef.current) fileRef.current.value = ''
  }

  async function confirmUploadSkin(model: 'slim' | 'classic') {
    if (!pendingFile || !uuid) return
    setModelDialogOpen(false)
    try {
      await uploadSkin(uuid, pendingFile, account?.loginMethod ?? 'Microsoft', account?.serverUrl, model)
      notify(t('accountDetail.skinUploaded'), 'success')
      handleSkinRefresh()
    } catch (e) {
      if (isMicrosoftAuthError(e)) setShowMicrosoftReauth(true)
      else notify(t('accountDetail.skinUploadFailed'), 'error')
    } finally {
      setPendingFile(null)
    }
  }

  async function handleSkinReset() {
    if (!uuid) return
    const ok = await msgConfirm(t('accountDetail.resetSkinConfirm'))
    if (!ok) return
    try {
      await resetSkin(uuid, account?.loginMethod ?? 'Microsoft', account?.serverUrl)
      notify(t('accountDetail.skinReset'), 'success')
      handleSkinRefresh()
    } catch (e) {
      if (isMicrosoftAuthError(e)) { setShowMicrosoftReauth(true); return }
      notify(t('accountDetail.skinResetFailed'), 'error')
    }
  }

  async function handleSkinDownload() {
    if (!uuid) return
    try {
      // Desktop (Tauri): native "另存为" dialog, backend writes the file.
      const dest = await save({ defaultPath: `${account?.name ?? uuid}.png`, filters: [{ name: 'PNG', extensions: ['png'] }] })
      if (!dest) return
      await saveSkinTo(uuid, dest, account?.loginMethod ?? 'Microsoft', account?.serverUrl)
      notify(t('accountDetail.skinSavedTo', { dest }), 'success')
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
      notify(t('accountDetail.skinDownloaded'), 'success')
    } catch { notify(t('accountDetail.skinDownloadFailed'), 'error') }
  }

  async function handleDelete() {
    if (!uuid) return
    const ok = await msgConfirm(t('accountDetail.deleteAccountConfirm'))
    if (!ok) return
    await deleteAccount(uuid)
    navigate('/accounts')
  }

  if (loading || !account) {
    return <div className="flex flex-1 h-full items-center justify-center overflow-y-auto text-muted-foreground">{t('accountDetail.loading')}</div>
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
            <div className="glass-surface flex flex-col items-center gap-3 rounded-xl border bg-card p-6">
              <SkinViewer3D textureUrl={textureUrl} model={profile?.model === 'slim' ? 'slim' : 'classic'} width={280} height={380} className="rounded-lg" name={account.name} showNameTag={showNameTag} panoramaUrl="/panorama.png" capeUrl={capeUrl} showCape={showCape} />
              <div className="flex flex-wrap items-center justify-center gap-4">
                <button onClick={() => setShowNameTag(v => !v)} className={`flex items-center gap-2 text-xs ${showNameTag ? 'text-primary' : 'text-muted-foreground'}`}>
                  <div className={`h-3.5 w-7 rounded-full p-0.5 transition-colors ${showNameTag ? 'bg-primary' : 'bg-input'}`}>
                    <div className={`h-2.5 w-2.5 rounded-full bg-background transition-transform ${showNameTag ? 'translate-x-3' : ''}`} />
                  </div>
                  {t('accountDetail.showNameTag')}
                </button>
                <button onClick={() => setShowCape(v => !v)} disabled={!capeUrl} className={`flex items-center gap-2 text-xs ${showCape && capeUrl ? 'text-primary' : 'text-muted-foreground'} ${!capeUrl ? 'opacity-40' : ''}`}>
                  <div className={`h-3.5 w-7 rounded-full p-0.5 transition-colors ${showCape && capeUrl ? 'bg-primary' : 'bg-input'}`}>
                    <div className={`h-2.5 w-2.5 rounded-full bg-background transition-transform ${showCape && capeUrl ? 'translate-x-3' : ''}`} />
                  </div>
                  {t('accountDetail.showCape')}
                </button>
                <Button variant="ghost" size="sm" onClick={handleSkinDownload} className="text-xs">
                  <FontAwesomeIcon icon={faDownload} className="h-3.5 w-3.5" />
                  {t('accountDetail.downloadSkin')}
                </Button>

              </div>
            </div>
        </div>

        <div className="space-y-4 lg:col-span-2">
          <div className="glass-surface rounded-xl border bg-card p-5">
            <h2 className="mb-3 text-sm font-semibold">{t('accountDetail.accountInfo')}</h2>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">{t('accountDetail.name')}</dt>
                <dd>{account.name}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">UUID</dt>
                <dd className="font-mono text-xs">{account.uuid}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">{t('accountDetail.type')}</dt>
                <dd>{account.loginMethod}</dd>
              </div>
              {account.serverUrl && (
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">{t('accountDetail.authServer')}</dt>
                  <dd className="text-xs">{account.serverUrl}</dd>
                </div>
              )}
              {profile && (
                <>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">{t('accountDetail.skinModel')}</dt>
                    <dd>{profile.model === 'slim' ? t('accountDetail.slim') : t('accountDetail.classic')}</dd>
                  </div>
                  {account.loginMethod === 'Microsoft' ? (
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">{t('accountDetail.cape')}</dt>
                      <dd>{activeCape ? capeDisplayName(activeCape.id, activeCape.alias, lang) : t('accountDetail.none')}</dd>
                    </div>
                  ) : profile.capeUrl ? (
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">{t('accountDetail.cape')}</dt>
                      <dd>{t('accountDetail.hasSkin')}</dd>
                    </div>
                  ) : null}
                </>
              )}
            </dl>
          </div>

          <div className="flex gap-2 flex-wrap">
            <Button variant="outline" size="sm" onClick={handleSkinRefresh}>
              <FontAwesomeIcon icon={faRotate} className="mr-1 h-3 w-3" /> {t('accountDetail.refreshSkin')}
            </Button>
            {account.loginMethod === 'Microsoft' ? (
              <>
                <Button variant="outline" size="sm" onClick={() => setCapeDialogOpen(true)}>
                  <FontAwesomeIcon icon={faShirt} className="mr-1 h-3 w-3" /> {t('accountDetail.switchCape')}
                </Button>
                <input ref={fileRef} type="file" accept="image/png" className="hidden" onChange={handleSkinUpload} />
                <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                  <FontAwesomeIcon icon={faUpload} className="mr-1 h-3 w-3" /> {t('accountDetail.uploadSkin')}
                </Button>
                <Dialog open={modelDialogOpen} onClose={() => setModelDialogOpen(false)} className="max-w-sm">
                  <DialogHeader onClose={() => setModelDialogOpen(false)}>
                    <DialogTitle>{t('accountDetail.chooseArmModel')}</DialogTitle>
                  </DialogHeader>
                  <DialogBody>
                    {pendingFile && (
                      <img src={URL.createObjectURL(pendingFile)} alt={t('accountDetail.skinPreview')} className="mx-auto h-28 w-28 object-contain rounded-md border" />
                    )}
                    <div className="mt-4 grid grid-cols-2 gap-3">
                      <Button variant="outline" onClick={() => confirmUploadSkin('classic')}>{t('accountDetail.classicArm')}</Button>
                      <Button variant="outline" onClick={() => confirmUploadSkin('slim')}>{t('accountDetail.slimArm')}</Button>
                    </div>
                  </DialogBody>
                </Dialog>
                {profile?.skinSource === 'local' && (
                  <Button variant="outline" size="sm" onClick={handleSkinReset}>
                    <FontAwesomeIcon icon={faUndo} className="mr-1 h-3 w-3" /> {t('accountDetail.resetSkin')}
                  </Button>
                )}
              </>
            ) : account.serverUrl ? (
              <Button variant="outline" size="sm" onClick={() => { const url = new URL(account.serverUrl!).origin; openUrl(url).catch(() => window.open(url, '_blank')) }}>
                <FontAwesomeIcon icon={faGlobe} className="mr-1 h-3 w-3" /> {t('accountDetail.goToSkinSite')}
              </Button>
            ) : null}
            <Button variant="destructive" size="sm" onClick={handleDelete}>
              <FontAwesomeIcon icon={faTrashCan} className="mr-1 h-3 w-3" /> {t('accountDetail.deleteAccount')}
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
      <MicrosoftReauthDialog
        open={showMicrosoftReauth}
        onClose={() => setShowMicrosoftReauth(false)}
        expiredAccountUuid={uuid}
      />
    </PageShell>
  )
}
