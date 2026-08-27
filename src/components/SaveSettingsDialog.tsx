import { useState, useEffect, useCallback } from 'react'
import { RotateCw, TriangleAlert } from 'lucide-react'
import { Button, Checkbox, Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter, Input, Label, Select, SelectOption } from './ui'
import { useMessageBox } from './ui'
import { useI18n } from '../i18n/index.tsx'
import { ApiError } from '../api/client.ts'
import { getSaveSettings, updateSaveSettings, restoreSaveFromOld } from '../api/instance-files.ts'
import type { SaveSettings, SaveGameRules } from '../types/index.ts'

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

/** SaveSettings 中所有 number 字段（数值输入用） */
type NumberKey = { [K in keyof SaveSettings]: SaveSettings[K] extends number ? K : never }[keyof SaveSettings]
/** SaveGameRules 中的数值规则（String 数字） */
type RuleNumberKey = 'randomTickSpeed' | 'spawnRadius' | 'maxEntityCramming'

/** 复选框行（check 值为 boolean） */
function CheckRow({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2">
      <Checkbox checked={checked} onCheckedChange={(c) => onChange(c === true)} />
      <span className="text-xs text-muted-foreground">{label}</span>
    </label>
  )
}

/** 分组标题行 */
function SectionLabel({ children }: { children: string }) {
  return (
    <Label className="border-b border-border/60 pb-1 text-xs font-medium text-foreground">{children}</Label>
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

  const updateRule = useCallback(<K extends keyof SaveGameRules>(key: K, value: SaveGameRules[K]) => {
    setSettings((prev) => (prev ? { ...prev, gameRules: { ...prev.gameRules, [key]: value } } : prev))
  }, [])

  /** 数字输入（int/float 通用；NaN → 0） */
  const numInput = (key: NumberKey, label: string, opts?: { step?: string; min?: number; max?: number }) => (
    <div className="grid gap-1.5">
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        step={opts?.step}
        min={opts?.min}
        max={opts?.max}
        value={settings ? String(settings[key]) : ''}
        onChange={(e) => {
          const v = Number(e.target.value)
          update(key, Number.isFinite(v) ? v : 0)
        }}
        className="h-8 text-xs"
      />
    </div>
  )

  /** 数值规则输入（String 数字） */
  const ruleNumInput = (key: RuleNumberKey, label: string) => (
    <div className="grid gap-1.5">
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        value={settings ? String(settings.gameRules[key]) : ''}
        onChange={(e) => {
          const v = Number(e.target.value)
          updateRule(key, Number.isFinite(v) ? v : 0)
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
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{t('instanceDetail.saveSettings.runningWarning')}</span>
          </div>
        )}
        {error ? (
          <div className="py-6 text-center text-sm text-destructive">{error}</div>
        ) : loading || !settings ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <RotateCw className="h-4 w-4 animate-spin" />{t('instanceDetail.loading')}
          </div>
        ) : (
          <div className="grid gap-4">
            {/* ── 基础信息 ── */}
            <div className="grid gap-3">
              <SectionLabel>{t('instanceDetail.saveSettings.sectionBasic')}</SectionLabel>
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
                <CheckRow checked={settings.difficultyLocked} onChange={(v) => update('difficultyLocked', v)} label={t('instanceDetail.saveSettings.difficultyLocked')} />
              </div>
            </div>

            {/* ── 天气与时间 ── */}
            <div className="grid gap-3">
              <SectionLabel>{t('instanceDetail.saveSettings.sectionWeather')}</SectionLabel>
              <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                <CheckRow checked={settings.raining} onChange={(v) => update('raining', v)} label={t('instanceDetail.saveSettings.raining')} />
                <CheckRow checked={settings.thundering} onChange={(v) => update('thundering', v)} label={t('instanceDetail.saveSettings.thundering')} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                {numInput('time', t('instanceDetail.saveSettings.time'))}
                {numInput('dayTime', t('instanceDetail.saveSettings.dayTime'))}
                {numInput('clearWeatherTime', t('instanceDetail.saveSettings.clearWeatherTime'))}
                {numInput('rainTime', t('instanceDetail.saveSettings.rainTime'))}
                {numInput('thunderTime', t('instanceDetail.saveSettings.thunderTime'))}
              </div>
            </div>

            {/* ── 出生点与商人 ── */}
            <div className="grid gap-3">
              <SectionLabel>{t('instanceDetail.saveSettings.sectionSpawn')}</SectionLabel>
              <div className="grid grid-cols-3 gap-3">
                {numInput('spawnX', t('instanceDetail.saveSettings.spawnX'))}
                {numInput('spawnY', t('instanceDetail.saveSettings.spawnY'))}
                {numInput('spawnZ', t('instanceDetail.saveSettings.spawnZ'))}
              </div>
              <div className="grid grid-cols-2 gap-3">
                {numInput('randomSeed', t('instanceDetail.saveSettings.randomSeed'))}
                {numInput('wanderingTraderSpawnChance', t('instanceDetail.saveSettings.wanderingTraderSpawnChance'))}
                {numInput('wanderingTraderSpawnDelay', t('instanceDetail.saveSettings.wanderingTraderSpawnDelay'))}
              </div>
            </div>

            {/* ── 世界边界 ── */}
            <div className="grid gap-3">
              <SectionLabel>{t('instanceDetail.saveSettings.sectionBorder')}</SectionLabel>
              <div className="grid grid-cols-2 gap-3">
                {numInput('borderCenterX', t('instanceDetail.saveSettings.borderCenterX'), { step: '1' })}
                {numInput('borderCenterZ', t('instanceDetail.saveSettings.borderCenterZ'), { step: '1' })}
                {numInput('borderSize', t('instanceDetail.saveSettings.borderSize'), { step: '1' })}
                {numInput('borderSafeZone', t('instanceDetail.saveSettings.borderSafeZone'), { step: '0.1' })}
                {numInput('borderDamagePerBlock', t('instanceDetail.saveSettings.borderDamagePerBlock'), { step: '0.1' })}
                {numInput('borderWarningBlocks', t('instanceDetail.saveSettings.borderWarningBlocks'), { step: '0.1' })}
                {numInput('borderWarningTime', t('instanceDetail.saveSettings.borderWarningTime'), { step: '0.1' })}
              </div>
            </div>

            {/* ── 游戏规则 ── */}
            <div className="grid gap-3">
              <SectionLabel>{t('instanceDetail.saveSettings.gameRules')}</SectionLabel>
              <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                <CheckRow checked={settings.gameRules.keepInventory} onChange={(v) => updateRule('keepInventory', v)} label={t('instanceDetail.saveSettings.ruleKeepInventory')} />
                <CheckRow checked={settings.gameRules.doDaylightCycle} onChange={(v) => updateRule('doDaylightCycle', v)} label={t('instanceDetail.saveSettings.ruleDoDaylightCycle')} />
                <CheckRow checked={settings.gameRules.doFireTick} onChange={(v) => updateRule('doFireTick', v)} label={t('instanceDetail.saveSettings.ruleDoFireTick')} />
                <CheckRow checked={settings.gameRules.mobGriefing} onChange={(v) => updateRule('mobGriefing', v)} label={t('instanceDetail.saveSettings.ruleMobGriefing')} />
                <CheckRow checked={settings.gameRules.doMobSpawning} onChange={(v) => updateRule('doMobSpawning', v)} label={t('instanceDetail.saveSettings.ruleDoMobSpawning')} />
                <CheckRow checked={settings.gameRules.doWeatherCycle} onChange={(v) => updateRule('doWeatherCycle', v)} label={t('instanceDetail.saveSettings.ruleDoWeatherCycle')} />
                <CheckRow checked={settings.gameRules.doMobLoot} onChange={(v) => updateRule('doMobLoot', v)} label={t('instanceDetail.saveSettings.ruleDoMobLoot')} />
                <CheckRow checked={settings.gameRules.doTileDrops} onChange={(v) => updateRule('doTileDrops', v)} label={t('instanceDetail.saveSettings.ruleDoTileDrops')} />
                <CheckRow checked={settings.gameRules.doEntityDrops} onChange={(v) => updateRule('doEntityDrops', v)} label={t('instanceDetail.saveSettings.ruleDoEntityDrops')} />
                <CheckRow checked={settings.gameRules.doNaturalRegeneration} onChange={(v) => updateRule('doNaturalRegeneration', v)} label={t('instanceDetail.saveSettings.ruleDoNaturalRegeneration')} />
                <CheckRow checked={settings.gameRules.doImmediateRespawn} onChange={(v) => updateRule('doImmediateRespawn', v)} label={t('instanceDetail.saveSettings.ruleDoImmediateRespawn')} />
                <CheckRow checked={settings.gameRules.doInsomnia} onChange={(v) => updateRule('doInsomnia', v)} label={t('instanceDetail.saveSettings.ruleDoInsomnia')} />
                <CheckRow checked={settings.gameRules.doPatrolSpawning} onChange={(v) => updateRule('doPatrolSpawning', v)} label={t('instanceDetail.saveSettings.ruleDoPatrolSpawning')} />
                <CheckRow checked={settings.gameRules.doTraderSpawning} onChange={(v) => updateRule('doTraderSpawning', v)} label={t('instanceDetail.saveSettings.ruleDoTraderSpawning')} />
                <CheckRow checked={settings.gameRules.drowningDamage} onChange={(v) => updateRule('drowningDamage', v)} label={t('instanceDetail.saveSettings.ruleDrowningDamage')} />
                <CheckRow checked={settings.gameRules.fallDamage} onChange={(v) => updateRule('fallDamage', v)} label={t('instanceDetail.saveSettings.ruleFallDamage')} />
                <CheckRow checked={settings.gameRules.fireDamage} onChange={(v) => updateRule('fireDamage', v)} label={t('instanceDetail.saveSettings.ruleFireDamage')} />
                <CheckRow checked={settings.gameRules.freezeDamage} onChange={(v) => updateRule('freezeDamage', v)} label={t('instanceDetail.saveSettings.ruleFreezeDamage')} />
                <CheckRow checked={settings.gameRules.showDeathMessages} onChange={(v) => updateRule('showDeathMessages', v)} label={t('instanceDetail.saveSettings.ruleShowDeathMessages')} />
                <CheckRow checked={settings.gameRules.announceAdvancements} onChange={(v) => updateRule('announceAdvancements', v)} label={t('instanceDetail.saveSettings.ruleAnnounceAdvancements')} />
                <CheckRow checked={settings.gameRules.commandBlockOutput} onChange={(v) => updateRule('commandBlockOutput', v)} label={t('instanceDetail.saveSettings.ruleCommandBlockOutput')} />
                <CheckRow checked={settings.gameRules.sendCommandFeedback} onChange={(v) => updateRule('sendCommandFeedback', v)} label={t('instanceDetail.saveSettings.ruleSendCommandFeedback')} />
                <CheckRow checked={settings.gameRules.reducedDebugInfo} onChange={(v) => updateRule('reducedDebugInfo', v)} label={t('instanceDetail.saveSettings.ruleReducedDebugInfo')} />
                <CheckRow checked={settings.gameRules.disableElytraMovementCheck} onChange={(v) => updateRule('disableElytraMovementCheck', v)} label={t('instanceDetail.saveSettings.ruleDisableElytraMovementCheck')} />
                <CheckRow checked={settings.gameRules.spectatorsGenerateChunks} onChange={(v) => updateRule('spectatorsGenerateChunks', v)} label={t('instanceDetail.saveSettings.ruleSpectatorsGenerateChunks')} />
                <CheckRow checked={settings.gameRules.doLimitedCrafting} onChange={(v) => updateRule('doLimitedCrafting', v)} label={t('instanceDetail.saveSettings.ruleDoLimitedCrafting')} />
              </div>
              <div className="grid grid-cols-3 gap-3">
                {ruleNumInput('randomTickSpeed', t('instanceDetail.saveSettings.ruleRandomTickSpeed'))}
                {ruleNumInput('spawnRadius', t('instanceDetail.saveSettings.ruleSpawnRadius'))}
                {ruleNumInput('maxEntityCramming', t('instanceDetail.saveSettings.ruleMaxEntityCramming'))}
              </div>
            </div>
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        {!error && settings && (
          <Button variant="outline" size="sm" onClick={() => void handleRestore()} disabled={restoring || saving} className="mr-auto gap-1.5">
            <RotateCw className={`h-3 w-3 ${restoring ? 'animate-spin' : ''}`} />
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
