// en 资源总表（结构必须与 zh-CN 完全一致，satisfies 编译期校验）
import common from './common'
import layout from './layout'
import errors from './errors'
import running from './running'
import settings from './settings'
import dashboard from './dashboard'
import instances from './instances'
import instanceDetail from './instanceDetail'
import downloads from './downloads'
import accounts from './accounts'
import accountDetail from './accountDetail'
import resource from './resource'
import resourceDetail from './resourceDetail'
import connect from './connect'
import plugins from './plugins'
import dialogs from './dialogs'
import tools from './tools'
import type { TranslationSchema } from '../types'

export default {
  common,
  layout,
  errors,
  running,
  settings,
  dashboard,
  instances,
  instanceDetail,
  downloads,
  accounts,
  accountDetail,
  resource,
  resourceDetail,
  connect,
  plugins,
  dialogs,
  tools,
} satisfies TranslationSchema
