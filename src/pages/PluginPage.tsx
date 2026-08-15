import { useParams } from 'react-router-dom'
import { usePluginStore } from '../stores/pluginStore.ts'
import { getInstance } from '../plugins/sandbox.ts'
import { useLayoutEffect, useRef } from 'react'
import { useI18n } from '../i18n/index.tsx'

function activateInlineScripts(container: HTMLElement) {
  const origGetElementById = document.getElementById.bind(document)
  const containerId = container.id || `plugin-root-${Math.random().toString(36).slice(2)}`
  if (!container.id) container.id = containerId

  document.getElementById = (id: string) => {
    if (id === 'root') return container
    return origGetElementById(id)
  }

  const scripts = [...container.querySelectorAll('script')]
  for (const oldScript of scripts) {
    const newScript = document.createElement('script')
    if (oldScript.src) {
      newScript.src = oldScript.src
    }
    if (oldScript.type) newScript.type = oldScript.type
    if (oldScript.crossOrigin) newScript.crossOrigin = oldScript.crossOrigin
    if (oldScript.noModule) newScript.noModule = oldScript.noModule
    if (oldScript.referrerPolicy) newScript.referrerPolicy = oldScript.referrerPolicy
    if (oldScript.integrity) newScript.integrity = oldScript.integrity
    if (!oldScript.src) {
      newScript.textContent = oldScript.textContent
    }
    oldScript.replaceWith(newScript)
  }
}

export default function PluginPage() {
  const { pluginId } = useParams<{ pluginId: string }>()
  const plugin = usePluginStore(s => s.plugins.find(p => p.manifest.id === pluginId))
  const containerRef = useRef<HTMLDivElement>(null)
  const { t } = useI18n()

  useLayoutEffect(() => {
    if (!pluginId) return
    if (plugin?.state !== 'active') return

    const timer = setInterval(() => {
      const inst = getInstance(pluginId)
      const el = containerRef.current
      if (!inst || !el) return

      if ('iframe' in inst) {
        clearInterval(timer)
        if (inst.iframe.parentElement !== el) {
          el.innerHTML = ''
          el.appendChild(inst.iframe)
        }
      } else if ('container' in inst) {
        const c = inst.container
        if (c.parentElement !== el) {
          el.innerHTML = ''
          c.className = 'flex-1'
          el.appendChild(c)
        }
        if (!c.innerHTML) return
        clearInterval(timer)
        if (!c.dataset.scriptsActivated) {
          c.dataset.scriptsActivated = 'true'
          activateInlineScripts(c)
        }
      }
    }, 50)

    return () => { clearInterval(timer) }
  }, [pluginId, plugin?.state])

  if (!plugin) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-muted-foreground">{t('plugins.notFound')}</p>
      </div>
    )
  }

  if (plugin.state !== 'active') {
    return (
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex items-center gap-3 border-b border-border/50 px-6 py-3">
          <h2 className="text-sm font-medium">{plugin.manifest.name}</h2>
          <span className="text-xs text-muted-foreground">v{plugin.manifest.version}</span>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <p className="text-muted-foreground">{t('plugins.notActivated')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border/50 px-6 py-3">
        <h2 className="text-sm font-medium">{plugin.manifest.name}</h2>
        <span className="text-xs text-muted-foreground">v{plugin.manifest.version}</span>
      </div>
      <div className="flex flex-1 overflow-hidden">
        <div ref={containerRef} className="flex flex-1" />
      </div>
    </div>
  )
}
