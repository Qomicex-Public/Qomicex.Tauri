import { useEffect, useState, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faArrowLeft, faRotate, faTrashCan, faUpload, faUndo, faGlobe } from '@fortawesome/free-solid-svg-icons'
import { getAccount, deleteAccount } from '../api/account.ts'
import { getSkinProfile, uploadSkin, resetSkin } from '../api/skin.ts'
import { API_BASE } from '../api/client.ts'
import { openUrl } from '@tauri-apps/plugin-opener'
import { SkinViewer3D } from '../components/SkinViewer3D.tsx'
import { useMessageBox } from '../components/ui/message-box.tsx'
import { Button } from '../components/ui/button.tsx'
import { PageShell } from '../components/PageShell.tsx'
import type { Account, SkinProfile } from '../types/index.ts'

export default function AccountDetail() {
  const { uuid } = useParams<{ uuid: string }>()
  const navigate = useNavigate()
  const { confirm: msgConfirm, notify } = useMessageBox()
  const [account, setAccount] = useState<Account | null>(null)
  const [profile, setProfile] = useState<SkinProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [showNameTag, setShowNameTag] = useState(true)
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

  async function handleSkinRefresh() {
    if (!uuid) return
    const prof = await getSkinProfile(uuid, account?.loginMethod ?? 'Microsoft', account?.serverUrl).catch(() => null)
    setProfile(prof)
  }

  async function handleSkinUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !uuid) return
    try {
      await uploadSkin(uuid, file)
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
      await resetSkin(uuid)
      notify('皮肤已重置', 'success')
      handleSkinRefresh()
    } catch { notify('皮肤重置失败', 'error') }
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

  const textureUrl = `${API_BASE}/skin/texture/${uuid}?type=${account.loginMethod}${account.serverUrl ? `&server=${encodeURIComponent(account.serverUrl)}` : ''}`

  return (
    <PageShell className="space-y-6 p-8 overflow-y-auto">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('/accounts')}>
          <FontAwesomeIcon icon={faArrowLeft} className="h-4 w-4" />
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">{account.name}</h1>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-1">
            <div className="flex flex-col items-center gap-3 rounded-xl border bg-card p-6">
              <SkinViewer3D textureUrl={textureUrl} model={profile?.model === 'slim' ? 'slim' : 'classic'} width={280} height={380} className="rounded-lg" name={account.name} showNameTag={showNameTag} panoramaUrl="/panorama.png" />
              <button onClick={() => setShowNameTag(v => !v)} className={`flex items-center gap-2 text-xs ${showNameTag ? 'text-primary' : 'text-muted-foreground'}`}>
                <div className={`h-3.5 w-7 rounded-full p-0.5 transition-colors ${showNameTag ? 'bg-primary' : 'bg-input'}`}>
                  <div className={`h-2.5 w-2.5 rounded-full bg-background transition-transform ${showNameTag ? 'translate-x-3' : ''}`} />
                </div>
                显示名称标签
              </button>
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
                  {profile.capeUrl && (
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">披风</dt>
                      <dd>有</dd>
                    </div>
                  )}
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
    </PageShell>
  )
}
