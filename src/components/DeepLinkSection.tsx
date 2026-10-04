import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Link2, RotateCw } from 'lucide-react'
import { Button, Switch, Tooltip, useMessageBox } from './ui'
import { SettingRow, SettingSection } from './settings/SettingRow.tsx'
import { useI18n } from '../i18n/index.tsx'

/** `deep_link_status` / `set_deep_link_enabled` 的返回结构（与 Rust 侧 camelCase 对齐）。 */
interface DeepLinkStatus {
  enabled: boolean
  /** 当前平台是否支持运行时开关。macOS 恒 false（协议写在打包期 Info.plist）。 */
  changeable: boolean
  /** 上一次自动注册是否失败（可重试）。 */
  failed: boolean
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * 「启动器设置 → 系统集成」区块：`qomicex-launcher://` 协议关联开关。
 *
 * 放在这里而不是单开一个设置分类：它和代理设置同类（都是本机行为配置），
 * 单独占一个侧边栏项会让设置页层级变重。
 *
 * 默认状态是**开**——启动器启动时若检测到未关联会直接写入（见
 * `src-tauri/src/deep_link.rs` 的 `register_scheme`），因为协议关联是用户装启动器时
 * 期望拿到的能力，否则网页/快捷方式里的链接一律无效。这里的开关给不想要它的人一个
 * 关掉的入口；关闭会同时写「用户意图」偏好文件，否则下次启动检测到未关联又会注册
 * 回去、开关白关。
 */
export default function DeepLinkSection() {
  const { t } = useI18n()
  const { notify } = useMessageBox()
  const [status, setStatus] = useState<DeepLinkStatus | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    if (!isTauri()) return
    try {
      setStatus(await invoke<DeepLinkStatus>('deep_link_status'))
    } catch (e) {
      console.error('[settings] deep_link_status failed:', e)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function toggle(next: boolean) {
    setBusy(true)
    try {
      const result = await invoke<DeepLinkStatus>('set_deep_link_enabled', { enabled: next })
      setStatus(result)
      // 后端在失败时保持原状态（不谎报已关/已开），所以这里只按返回的权威状态提示。
      if (result.enabled !== next) {
        notify(t('settings.integration.deepLinkFailed'), 'error')
      }
    } catch (e) {
      console.error('[settings] set_deep_link_enabled failed:', e)
      notify(t('settings.integration.deepLinkFailed'), 'error')
    } finally {
      setBusy(false)
    }
  }

  const changeable = status?.changeable ?? false

  return (
    <SettingSection title={t('settings.integration.title')} icon={<Link2 className="h-4 w-4" />}>
      <SettingRow
        label={t('settings.integration.deepLink')}
        description={
          changeable
            ? t('settings.integration.deepLinkDesc')
            : `${t('settings.integration.deepLinkDesc')} ${t('settings.integration.deepLinkMacNote')}`
        }
        control={
          <div className="flex items-center gap-2">
            {status?.failed && (
              <Tooltip content={t('settings.integration.deepLinkFailed')}>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-amber-400"
                  onClick={() => void toggle(true)}
                  disabled={busy || !changeable}
                >
                  <RotateCw className="h-3.5 w-3.5" />
                </Button>
              </Tooltip>
            )}
            {/* macOS 上 changeable=false：开关置灰只读并说明原因，而不是给一个点了没反应的控件 */}
            <Switch
              checked={status?.enabled ?? false}
              onCheckedChange={(c) => void toggle(c === true)}
              disabled={busy || !changeable}
            />
          </div>
        }
      />
    </SettingSection>
  )
}
