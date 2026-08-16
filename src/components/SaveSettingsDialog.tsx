import { useState, useEffect, useCallback } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faRotate, faTriangleExclamation } from '@fortawesome/free-solid-svg-icons'
import { Button, Checkbox, Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter, Input, Label, Select, SelectOption } from './ui'
import { useMessageBox } from './ui'
import { useI18n } from '../i18n/index.tsx'
import { ApiError } from '../api/client.ts'
import { getSaveSettings, updateSaveSettings, restoreSaveFromOld } from '../api/instance-files.ts'
import type { SaveSettings } from '../types/index.ts'

interface Props {
  open: boolean
  onClose: () => void
  instanceId: string
  /** 存档显示名（LevelName） */
  saveName: string
  /** 存档目录名（API 路径用；= filePath 末段） */
  folderName: string
  /** 实例是否运行中（写入会被游戏保存覆盖 → 警告） */
  running: boolean
  /** 保存成功后回调（如名称变更 → 刷新存档列表） */
  onSaved?: () => void
}

const GAME_TYPES = ['gameTypeSurvival', 'gameTypeCreative', 'gameTypeAdventure', 'gameTypeSpectator'] as const
const DIFFICULTIES = ['difficultyPeaceful', 'difficultyEasy', 'difficultyNormal', 'difficultyHard'] as const

/** 复选框行（check 值为 boolean） */
function CheckRow({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2">
      <Checkbox checked={checked} onCheckedChange={(c) => onChange(c === true)} />
      <span className="text-xs text-muted-foreground">{label}</span>
    </label>
  )
}

export default function SaveSettingsDialog({ open, onClose, instanceId, saveName, folderName, running, onSaved }: Props) {
  const { t } = useI18n()
  const { notify, confirm } = useMessageBox()
  const [settings, setSettings] = useState<SaveSettings | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await getSaveSettings(instanceId, folderName)
      setSettings(data)
    } catch (e) {
      setError(e instanceof ApiError ? e.displayMessage : String(e))
    }
    setLoading(false)
  }, [instanceId, folderName])

  useEffect(() => {
    if (open) {
      setSettings(null)
      void load()
    }
  }, [open, load])

  const update = useCallback(<K extends keyof SaveSettings>(key: K, value: SaveSettings[K]) => {
    setSettings((prev) => (prev ? { ...prev, [key]: value } : prev))
  }, [])

  const updateRule = useCallback((key: keyof SaveSettings['gameRules'], value: boolean) => {
    setSettings((prev) => (prev ? { ...prev, gameRules: { ...prev.gameRules, [key]: value } } : prev))
  }, [])

  const numInput = (key: 'time' | 'dayTime' | 'spawnX' | 'spawnY' | 'spawnZ' | 'randomSeed', label: string) => (
    <div className="grid gap-1.5">
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        value={settings ? String(settings[key]) : ''}
        onChange={(e) => {
          const v = Number(e.target.value)
          update(key, Number.isFinite(v) ? v : 0)
        }}
        className="h-8 text-xs"
      />
    </div>
  )

  const handleSave = useCallback(async () => {
    if (!settings) return
    setSaving(true)
    try {
      const updated = await updateSaveSettings(instanceId, folderName, settings)
      setSettings(updated)
      notify(t('instanceDetail.saveSettings.saved'), 'success')
      onSaved?.()
      onClose()
    } catch (e) {
      notify(
        t('instanceDetail.saveSettings.saveFailed', {
          error: e instanceof ApiError ? e.displayMessage : String(e),
        }),
        'error',
      )
    }
    setSaving(false)
  }, [settings, instanceId, folderName, notify, t, onSaved, onClose])

  const handleRestore = useCallback(async () => {
    const ok = await confirm(
      t('instanceDetail.saveSettings.restoreFromOld'),
      t('instanceDetail.saveSettings.restoreFromOldConfirm'),
    )
    if (!ok) return
    setRestoring(true)
    try {
      const updated = await restoreSaveFromOld(instanceId, folderName)
      setSettings(updated)
      notify(t('instanceDetail.saveSettings.restored'), 'success')
    } catch (e) {
      notify(
        t('instanceDetail.saveSettings.restoreFailed', {
          error: e instanceof ApiError ? e.displayMessage : String(e),
        }),
        'error',
      )
    }
    setRestoring(false)
  }, [instanceId, folderName, notify, confirm, t])

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogHeader onClose={onClose}>
        <DialogTitle>{t('instanceDetail.saveSettings.title')} · {saveName}</DialogTitle>
      </DialogHeader>
      <DialogBody className="max-h-[70vh] overflow-y-auto">
        {running && (
          <div className="mb-3 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
            <FontAwesomeIcon icon={faTriangleExclamation} className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{t('instanceDetail.saveSettings.runningWarning')}</span>
          </div>
        )}
        {error ? (
          <div className="py-6 text-center text-sm text-destructive">{error}</div>
        ) : loading || !settings ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <FontAwesomeIcon icon={faRotate} className="h-4 w-4 animate-spin" />{t('instanceDetail.loading')}
          </div>
        ) : (
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label className="text-xs">{t('instanceDetail.saveSettings.levelName')}</Label>
              <Input value={settings.levelName} onChange={(e) => update('levelName', e.target.value)} className="h-8 text-xs" />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label className="text-xs">{t('instanceDetail.saveSettings.gameType')}</Label>
                <Select value={String(settings.gameType)} onChange={(v) => update('gameType', Number(v))} className="h-8 text-xs">
                  {GAME_TYPES.map((k, i) => (
                    <SelectOption key={k} value={String(i)}>{t(`instanceDetail.saveSettings.${k}`)}</SelectOption>
                  ))}
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">{t('instanceDetail.saveSettings.difficulty')}</Label>
                <Select value={String(settings.difficulty)} onChange={(v) => update('difficulty', Number(v))} className="h-8 text-xs">
                  {DIFFICULTIES.map((k, i) => (
                    <SelectOption key={k} value={String(i)}>{t(`instanceDetail.saveSettings.${k}`)}</SelectOption>
                  ))}
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-x-3 gap-y-2">
              <CheckRow checked={settings.allowCommands} onChange={(v) => update('allowCommands', v)} label={t('instanceDetail.saveSettings.allowCommands')} />
              <CheckRow checked={settings.hardcore} onChange={(v) => update('hardcore', v)} label={t('instanceDetail.saveSettings.hardcore')} />
              <CheckRow checked={settings.raining} onChange={(v) => update('raining', v)} label={t('instanceDetail.saveSettings.raining')} />
              <CheckRow checked={settings.thundering} onChange={(v) => update('thundering', v)} label={t('instanceDetail.saveSettings.thundering')} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              {numInput('time', t('instanceDetail.saveSettings.time'))}
              {numInput('dayTime', t('instanceDetail.saveSettings.dayTime'))}
              {numInput('spawnX', t('instanceDetail.saveSettings.spawnX'))}
              {numInput('spawnY', t('instanceDetail.saveSettings.spawnY'))}
              {numInput('spawnZ', t('instanceDetail.saveSettings.spawnZ'))}
              {numInput('randomSeed', t('instanceDetail.saveSettings.randomSeed'))}
            </div>

            <div className="grid gap-1.5">
              <Label className="text-xs">{t('instanceDetail.saveSettings.gameRules')}</Label>
              <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                <CheckRow checked={settings.gameRules.keepInventory} onChange={(v) => updateRule('keepInventory', v)} label={t('instanceDetail.saveSettings.ruleKeepInventory')} />
                <CheckRow checked={settings.gameRules.doDaylightCycle} onChange={(v) => updateRule('doDaylightCycle', v)} label={t('instanceDetail.saveSettings.ruleDoDaylightCycle')} />
                <CheckRow checked={settings.gameRules.doFireTick} onChange={(v) => updateRule('doFireTick', v)} label={t('instanceDetail.saveSettings.ruleDoFireTick')} />
                <CheckRow checked={settings.gameRules.mobGriefing} onChange={(v) => updateRule('mobGriefing', v)} label={t('instanceDetail.saveSettings.ruleMobGriefing')} />
                <CheckRow checked={settings.gameRules.doMobSpawning} onChange={(v) => updateRule('doMobSpawning', v)} label={t('instanceDetail.saveSettings.ruleDoMobSpawning')} />
                <CheckRow checked={settings.gameRules.doWeatherCycle} onChange={(v) => updateRule('doWeatherCycle', v)} label={t('instanceDetail.saveSettings.ruleDoWeatherCycle')} />
              </div>
            </div>
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        {!error && settings && (
          <Button variant="outline" size="sm" onClick={() => void handleRestore()} disabled={restoring || saving} className="mr-auto gap-1.5">
            <FontAwesomeIcon icon={faRotate} className={`h-3 w-3 ${restoring ? 'animate-spin' : ''}`} />
            {t('instanceDetail.saveSettings.restoreFromOld')}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={onClose}>{t('instanceDetail.confirm.cancel')}</Button>
        <Button size="sm" onClick={() => void handleSave()} disabled={saving || loading || !settings || !!error}>
          {saving ? t('instanceDetail.saveSettings.saving') : t('instanceDetail.saveSettings.save')}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
