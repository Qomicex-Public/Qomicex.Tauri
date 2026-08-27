import { useState } from 'react'
import { CloudDownload, ListChecks, Puzzle, User } from 'lucide-react'
import { Tabs } from './ui'
import { SettingSection } from './settings/SettingRow.tsx'
import { useI18n } from '../i18n/index.tsx'
import PluginStoreBrowse from './PluginStoreBrowse.tsx'
import PluginStoreManage from './PluginStoreManage.tsx'
import PluginStoreAccount from './PluginStoreAccount.tsx'

export default function PluginStoreTab() {
  const { t } = useI18n()
  const [subTab, setSubTab] = useState('browse')

  return (
    <SettingSection title={t('settings.plugins.title')} icon={<Puzzle className="h-4 w-4" />}>
        <div className="space-y-4 p-4">
          <Tabs
            tabs={[
              { id: 'browse', label: t('settings.plugins.store.tabBrowse'), icon: <CloudDownload className="h-3.5 w-3.5" /> },
              { id: 'manage', label: t('settings.plugins.store.tabManage'), icon: <ListChecks className="h-3.5 w-3.5" /> },
              { id: 'account', label: t('settings.plugins.store.tabAccount'), icon: <User className="h-3.5 w-3.5" /> },
            ]}
            activeTab={subTab}
            onChange={setSubTab}
          />
          {subTab === 'browse' && <PluginStoreBrowse />}
          {subTab === 'manage' && <PluginStoreManage />}
          {subTab === 'account' && <PluginStoreAccount />}
        </div>
      </SettingSection>
  )
}
