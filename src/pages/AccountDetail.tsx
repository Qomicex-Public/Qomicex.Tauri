import { useEffect, useState, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faArrowLeft, faRotate, faTrashCan, faUpload, faUndo } from '@fortawesome/free-solid-svg-icons'
import { getAccount, deleteAccount } from '../api/account.ts'
import { getSkinProfile, uploadSkin, resetSkin } from '../api/skin.ts'
import { SkinViewer3D } from '../components/SkinViewer3D.tsx'
import { useMessageBox } from '../components/ui/message-box.tsx'
import { Button } from '../components/ui/button.tsx'
import type { Account, SkinProfile } from '../types/index.ts'

export default function AccountDetail() {
  const { uuid } = useParams<{ uuid: string }>()
  const navigate = useNavigate()
  const { confirm: msgConfirm, notify } = useMessageBox()
  const [account, setAccount] = useState<Account | null>(null)
  const [profile, setProfile] = useState<SkinProfile | null>(null)
  const [loading, setLoading] = useState(true)
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
    return <div className="flex h-full items-center justify-center text-muted-foreground">加载中...</div>
  }

  const textureUrl = `/api/skin/texture/${uuid}?type=${account.loginMethod}${account.serverUrl ? `&server=${encodeURIComponent(account.serverUrl)}` : ''}`

  return (
    <div className="space-y-6 p-8">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('/accounts')}>
          <FontAwesomeIcon icon={faArrowLeft} className="h-4 w-4" />
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">{account.name}</h1>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-1">
            <div className="flex items-center justify-center rounded-xl border bg-card p-6">
              <SkinViewer3D textureUrl={textureUrl} model={profile?.model === 'slim' ? 'slim' : 'classic'} width={280} height={380} className="rounded-lg" />
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
            <input ref={fileRef} type="file" accept="image/png" className="hidden" onChange={handleSkinUpload} />
            <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
              <FontAwesomeIcon icon={faUpload} className="mr-1 h-3 w-3" /> 上传皮肤
            </Button>
            {profile?.skinSource === 'local' && (
              <Button variant="outline" size="sm" onClick={handleSkinReset}>
                <FontAwesomeIcon icon={faUndo} className="mr-1 h-3 w-3" /> 重置皮肤
              </Button>
            )}
            <Button variant="destructive" size="sm" onClick={handleDelete}>
              <FontAwesomeIcon icon={faTrashCan} className="mr-1 h-3 w-3" /> 删除账户
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
