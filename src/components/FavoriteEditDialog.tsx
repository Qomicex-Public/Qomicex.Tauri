import { useEffect, useMemo, useState } from 'react'
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from './ui'
import { Button } from './ui'
import { Input } from './ui'
import { Label } from './ui'
import { Textarea } from './ui'
import { Select, SelectOption } from './ui'
import { Badge } from './ui'
import { cn } from './ui'
import { X } from 'lucide-react'
import { useI18n } from '../i18n/index.tsx'
import type { ResourceFavorite } from '../types/index.ts'
import { useFavoritesStore, useFolderMap } from '../stores/favoritesStore.ts'

/** 备注与标签的与服务端一致的上限（服务端还会再截断一次，这里只为 UI 提示）。 */
export const MAX_NOTE_CHARS = 2000
export const MAX_TAGS = 20
export const MAX_TAG_CHARS = 32

/** 「未分组」在 `Select` 里的哨兵值：避免用 `''` 与「未选中」混淆。 */
const NO_FOLDER = '__none__'

interface Props {
  open: boolean
  onClose: () => void
  /** 被编辑的收藏条目（`null` = 无可编辑对象，弹窗不渲染内容）。 */
  favorite: ResourceFavorite | null
  /** 资源分类（唯一键的一部分，由页面状态提供）。 */
  category: string
  /** 保存成功后的回调（父组件据此提示成功；失败由弹窗内展示）。 */
  onSaved?: () => void
}

/**
 * 「编辑收藏」弹窗：收藏夹 / 备注 / 自定义标签一次改完。
 *
 * 卡片上的 ✎ 与资源详情页共用本组件；保存走 `updateFavoriteMeta`
 * （即 P1 的 upsert，按收藏键串行化 + 乐观更新 + 失败回滚）。
 */
export default function FavoriteEditDialog({ open, onClose, favorite, category, onSaved }: Props) {
  const { t } = useI18n()
  const folderMap = useFolderMap()
  const folders = useFavoritesStore((s) => s.folders)
  const updateFavoriteMeta = useFavoritesStore((s) => s.updateFavoriteMeta)

  const initialFolder = useMemo(
    () => (favorite?.folderId && folderMap.has(favorite.folderId) ? favorite.folderId : NO_FOLDER),
    [favorite, folderMap],
  )
  const [folderId, setFolderId] = useState(initialFolder)
  const [note, setNote] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // 每次打开都用当前条目重置本地编辑态（关闭时不保留草稿）。
  useEffect(() => {
    if (!open || !favorite) return
    setFolderId(initialFolder)
    setNote(favorite.note ?? '')
    setTags(favorite.tags ?? [])
    setTagInput('')
    setError('')
  }, [open, favorite, initialFolder])

  /** 追加一个标签：裁剪、去空、大小写不敏感去重、超长截断、数量封顶。 */
  const addTag = (raw: string) => {
    const tag = raw.trim().slice(0, MAX_TAG_CHARS)
    if (!tag) return
    setTags((prev) => {
      if (prev.length >= MAX_TAGS) return prev
      if (prev.some((x) => x.toLowerCase() === tag.toLowerCase())) return prev
      return [...prev, tag]
    })
    setTagInput('')
  }

  const removeTag = (tag: string) => setTags((prev) => prev.filter((x) => x !== tag))

  const handleTagKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
      e.preventDefault()
      addTag(tagInput)
      return
    }
    // 输入框为空时退格 = 删除最后一个标签（常见 chips 交互）。
    if (e.key === 'Backspace' && !tagInput) setTags((prev) => prev.slice(0, -1))
  }

  const handleSave = async () => {
    if (!favorite || saving) return
    setSaving(true)
    setError('')
    try {
      await updateFavoriteMeta(favorite, category, {
        folderId: folderId === NO_FOLDER ? null : folderId,
        note: note.trim() ? note.trim() : null,
        tags,
      })
      onSaved?.()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('resource.favorites.edit.failed'))
    }
    setSaving(false)
  }

  return (
    <Dialog open={open} onClose={saving ? () => {} : onClose} closeOnBackdrop={!saving} closeOnEsc={!saving}>
      <DialogHeader onClose={saving ? undefined : onClose}>
        <DialogTitle>{t('resource.favorites.edit.title')}</DialogTitle>
      </DialogHeader>
      <DialogBody className="space-y-4">
        {favorite && (
          <p className="truncate text-xs text-muted-foreground">{favorite.title}</p>
        )}

        <div className="space-y-1.5">
          <Label>{t('resource.favorites.edit.folderLabel')}</Label>
          <Select value={folderId} onChange={setFolderId} placeholder={t('resource.favorites.edit.none')}>
            <SelectOption value={NO_FOLDER}>{t('resource.favorites.edit.none')}</SelectOption>
            {folders.map((f) => (
              <SelectOption key={f.id} value={f.id}>
                {f.name}
              </SelectOption>
            ))}
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label>{t('resource.favorites.note.label')}</Label>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={MAX_NOTE_CHARS}
            placeholder={t('resource.favorites.note.placeholder')}
            className="min-h-[72px] resize-y"
          />
        </div>

        <div className="space-y-1.5">
          <Label>{t('resource.favorites.tags.label')}</Label>
          <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5">
            {tags.map((tag) => (
              <Badge key={tag} variant="secondary" className="gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium">
                {tag}
                <button
                  type="button"
                  onClick={() => removeTag(tag)}
                  aria-label={t('resource.favorites.tags.remove', { tag })}
                  className="text-muted-foreground transition-colors hover:text-foreground"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </Badge>
            ))}
            <Input
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={handleTagKeyDown}
              onBlur={() => addTag(tagInput)}
              maxLength={MAX_TAG_CHARS}
              disabled={tags.length >= MAX_TAGS}
              placeholder={tags.length >= MAX_TAGS ? t('resource.favorites.tags.limitReached', { max: MAX_TAGS }) : t('resource.favorites.tags.placeholder')}
              className={cn('h-7 min-w-[140px] flex-1 border-0 px-1 shadow-none focus-visible:ring-0 focus-visible:animate-none')}
            />
          </div>
          <p className="text-[11px] text-muted-foreground/70">{t('resource.favorites.tags.hint', { max: MAX_TAGS })}</p>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={saving}>
          {t('resource.favorites.edit.cancel')}
        </Button>
        <Button onClick={handleSave} disabled={saving || !favorite}>
          {saving ? t('resource.favorites.edit.saving') : t('resource.favorites.edit.save')}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
