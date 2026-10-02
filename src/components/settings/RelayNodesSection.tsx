import { useEffect, useState } from 'react'
import { Plus, Trash2, RotateCw, Info } from 'lucide-react'
import { Button } from '../ui'
import { Input } from '../ui'
import { Label } from '../ui'
import { Tooltip } from '../ui'
import { useMessageBox } from '../ui'
import { reloadRelayNodes } from '../../api/connector.ts'
import { ApiError } from '../../api/client.ts'
import { cn } from '../../lib/utils.ts'
import { useI18n } from '../../i18n/index.tsx'

interface RelayNodesSectionProps {
  /** 当前已保存的自定义节点列表（空/undefined = 只用官方节点）。 */
  value: string[] | null | undefined
  /** 保存新列表（由父组件落盘）。 */
  onSave: (nodes: string[] | null) => void
}

/** 前端预校验，与后端 `validate_relay_node` 保持同义（后端仍是权威）。
 *  只用于即时反馈：让用户当场看到格式错，而不是等保存被拒。
 *
 *  两类形态（对齐 easytier `TunnelScheme` 全集）：
 *  - 直连协议 tcp/udp/wg/quic/ws/wss/faketcp → `scheme://host:port`，必须带端口；
 *  - manual endpoint http/https/txt/srv/ring → URL 形态，允许路径、允许省略端口
 *    （easytier 会自己去 GET 解析，官方节点服务就是这种）。
 */
const IP_SCHEMES = ['tcp', 'udp', 'wg', 'quic', 'ws', 'wss', 'faketcp']
const ENDPOINT_SCHEMES = ['http', 'https', 'txt', 'srv', 'ring']

function localValidate(raw: string): string | null {
  const node = raw.trim()
  if (!node) return 'empty'
  const m = node.match(/^([a-zA-Z]+):\/\/(.+)$/)
  if (!m) return 'noScheme'
  const scheme = m[1].toLowerCase()
  if (!IP_SCHEMES.includes(scheme) && !ENDPOINT_SCHEMES.includes(scheme)) return 'badScheme'
  const rest = m[2]
  if (!rest || /\s/.test(rest)) return 'badHost'

  if (ENDPOINT_SCHEMES.includes(scheme)) {
    const authority = rest.split(/[/?#]/)[0]
    if (!authority) return 'badHost'
    const close = authority.indexOf(']')
    const portPart = close >= 0
      ? authority.slice(close + 1).replace(/^:/, '')
      : (authority.includes(':') ? authority.split(':').pop() ?? '' : '')
    if (portPart) {
      const port = Number(portPart)
      if (!Number.isInteger(port) || port <= 0 || port > 65535) return 'badPort'
    }
    return null
  }

  // 直连协议：必须有 host:port
  const close = rest.indexOf(']')
  const portPart = close >= 0 ? rest.slice(close + 1).replace(/^:/, '') : rest.split(':').pop() ?? ''
  const host = close >= 0 ? rest.slice(0, close + 1) : rest.slice(0, rest.lastIndexOf(':'))
  if (!host || !rest.includes(':')) return 'badHost'
  const port = Number(portPart)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return 'badPort'
  return null
}

/**
 * 自定义联机中继节点编辑区（issue #112）。
 *
 * 语义：**自定义节点在前、官方节点在后**。留空 = 只用官方节点。
 *
 * 为什么用本地草稿 + 显式「应用」而非逐键保存：设置页的 `update()` 每次改动都会
 * 立即 POST /settings，而半成品地址（如 `tcp:/`）会被后端校验拒绝，用户会看到
 * 一连串保存失败。改为草稿 + 应用后，只在用户确认时提交一次，且能顺带触发
 * 联机客户端重载使配置即时生效（中继节点在客户端构造时固化，不重载需重启）。
 */
export default function RelayNodesSection({ value, onSave }: RelayNodesSectionProps) {
  const { t } = useI18n()
  const { notify } = useMessageBox()
  const [nodes, setNodes] = useState<string[]>(value ?? [])
  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  const [applying, setApplying] = useState(false)

  // 外部值变化（如初始化加载完成）时同步——仅在未编辑时，避免覆盖用户草稿。
  useEffect(() => {
    if (!dirty) setNodes(value ?? [])
  }, [value, dirty])

  const draftError = draft.trim() ? localValidate(draft) : null

  const addNode = () => {
    const err = localValidate(draft)
    if (err) {
      notify(t(`settings.relayNodes.errors.${err}`), 'error')
      return
    }
    const node = draft.trim()
    if (nodes.includes(node)) {
      notify(t('settings.relayNodes.duplicate'), 'warning')
      return
    }
    setNodes([...nodes, node])
    setDraft('')
    setDirty(true)
  }

  const removeNode = (node: string) => {
    setNodes(nodes.filter((n) => n !== node))
    setDirty(true)
  }

  const apply = async () => {
    setApplying(true)
    try {
      onSave(nodes.length > 0 ? nodes : null)
      const res = await reloadRelayNodes()
      setDirty(false)
      notify(
        res.usingCustom
          ? t('settings.relayNodes.appliedCustom', { count: res.customNodeCount })
          : t('settings.relayNodes.appliedOfficial'),
        'success',
      )
    } catch (e) {
      const msg = e instanceof ApiError ? e.displayMessage : t('settings.relayNodes.applyFailed')
      notify(msg, 'error')
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="space-y-3 p-4">
      <p className="text-xs text-muted-foreground">{t('settings.relayNodes.description')}</p>

      {/* 已添加的节点 */}
      {nodes.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
          {t('settings.relayNodes.empty')}
        </p>
      ) : (
        <ul className="space-y-1">
          {nodes.map((node, idx) => (
            <li
              key={node}
              className="flex items-center gap-2 rounded-lg border bg-card/40 px-3 py-1.5"
            >
              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                {idx + 1}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{node}</span>
              <Tooltip content={t('settings.relayNodes.remove')}>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => removeNode(node)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}

      {/* 新增 */}
      <div className="space-y-1.5">
        <Label htmlFor="relay-node-input">{t('settings.relayNodes.addLabel')}</Label>
        <div className="flex gap-2">
          <Input
            id="relay-node-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addNode()
              }
            }}
            placeholder="tcp://relay.example.com:11010"
            className={cn('max-w-sm font-mono', draftError && 'border-destructive')}
          />
          <Button variant="outline" className="gap-1.5" onClick={addNode} disabled={!draft.trim()}>
            <Plus className="h-3.5 w-3.5" />
            {t('settings.relayNodes.add')}
          </Button>
        </div>
        {draftError && (
          <p className="text-xs text-destructive">
            {t(`settings.relayNodes.errors.${draftError}`)}
          </p>
        )}
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3 w-3 shrink-0" />
          {t('settings.relayNodes.formatHint')}
        </p>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <Button size="sm" className="gap-1.5" onClick={apply} disabled={applying || !dirty && nodes.length === (value?.length ?? 0)}>
          <RotateCw className={cn('h-3.5 w-3.5', applying && 'animate-spin')} />
          {applying ? t('settings.relayNodes.applying') : t('settings.relayNodes.apply')}
        </Button>
      </div>
    </div>
  )
}
