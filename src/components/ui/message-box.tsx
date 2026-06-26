import * as React from "react"
import { cn } from "../../lib/utils.ts"
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome"
import { faCircleInfo, faTriangleExclamation, faCheckCircle, faCircleXmark } from "@fortawesome/free-solid-svg-icons"
import { Button } from "./button.tsx"
import { Input } from "./input.tsx"
import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from "./dialog.tsx"

type MessageBoxType = "info" | "error" | "warning" | "success"

interface MessageBoxState {
  open: boolean
  type: MessageBoxType
  title: string
  message: string
  confirmText: string
  cancelText?: string
  resolve: ((value: boolean) => void) | null
}

interface PromptState {
  open: boolean
  title: string
  message: string
  defaultValue: string
  confirmText: string
  cancelText: string
  resolve: ((value: string | null) => void) | null
}

const ICONS: Record<MessageBoxType, { icon: typeof faCircleInfo; className: string }> = {
  info: { icon: faCircleInfo, className: "text-blue-400" },
  error: { icon: faCircleXmark, className: "text-red-400" },
  warning: { icon: faTriangleExclamation, className: "text-amber-400" },
  success: { icon: faCheckCircle, className: "text-emerald-400" },
}

interface MessageBoxContextValue {
  alert: (message: string, title?: string) => Promise<void>
  confirm: (message: string, title?: string) => Promise<boolean>
  error: (message: string, title?: string) => Promise<void>
  success: (message: string, title?: string) => Promise<void>
  prompt: (message: string, title?: string, defaultValue?: string) => Promise<string | null>
}

const MessageBoxContext = React.createContext<MessageBoxContextValue>({
  alert: async () => {},
  confirm: async () => false,
  error: async () => {},
  success: async () => {},
  prompt: async () => null,
})

function MessageBoxProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<MessageBoxState>({
    open: false, type: "info", title: "", message: "", confirmText: "确定", cancelText: undefined, resolve: null,
  })
  const [promptState, setPromptState] = React.useState<PromptState>({
    open: false, title: "", message: "", defaultValue: "", confirmText: "确定", cancelText: "取消", resolve: null,
  })
  const promptInputRef = React.useRef<HTMLInputElement>(null)
  const [promptValue, setPromptValue] = React.useState("")

  const show = React.useCallback((type: MessageBoxType, message: string, title?: string, confirmText = "确定", cancelText?: string): Promise<boolean> => {
    return new Promise((resolve) => {
      setState({
        open: true, type,
        title: title || (type === "error" ? "错误" : type === "warning" ? "警告" : type === "success" ? "成功" : "提示"),
        message, confirmText, cancelText, resolve,
      })
    })
  }, [])

  const alert = React.useCallback((message: string, title?: string) => show("info", message, title).then(() => {}), [show])
  const confirm = React.useCallback((message: string, title?: string) => show("warning", message, title, "确定", "取消"), [show])
  const error = React.useCallback((message: string, title?: string) => show("error", message, title).then(() => {}), [show])
  const success = React.useCallback((message: string, title?: string) => show("success", message, title).then(() => {}), [show])

  const prompt = React.useCallback((message: string, title?: string, defaultValue = ""): Promise<string | null> => {
    return new Promise((resolve) => {
      setPromptValue(defaultValue)
      setPromptState({
        open: true, title: title || "输入", message, defaultValue, confirmText: "确定", cancelText: "取消", resolve,
      })
    })
  }, [])

  React.useEffect(() => {
    if (promptState.open) {
      setTimeout(() => promptInputRef.current?.focus(), 50)
    }
  }, [promptState.open])

  function handleMessageBoxClose(result: boolean) {
    state.resolve?.(result)
    setState((prev) => ({ ...prev, open: false, resolve: null }))
  }

  function handlePromptClose(value: string | null) {
    promptState.resolve?.(value)
    setPromptState((prev) => ({ ...prev, open: false, resolve: null }))
  }

  const ctx = React.useMemo(() => ({ alert, confirm, error, success, prompt }), [alert, confirm, error, success, prompt])

  return (
    <MessageBoxContext.Provider value={ctx}>
      {children}

      <Dialog open={state.open} onClose={() => handleMessageBoxClose(false)}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FontAwesomeIcon icon={ICONS[state.type].icon} className={cn("h-4 w-4", ICONS[state.type].className)} />
            {state.title}
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm leading-relaxed">{state.message}</p>
        </DialogBody>
        <DialogFooter>
          {state.cancelText && (
            <Button variant="secondary" onClick={() => handleMessageBoxClose(false)}>
              {state.cancelText}
            </Button>
          )}
          <Button
            variant={state.type === "error" ? "destructive" : "default"}
            onClick={() => handleMessageBoxClose(true)}
          >
            {state.confirmText}
          </Button>
        </DialogFooter>
      </Dialog>

      <Dialog open={promptState.open} onClose={() => handlePromptClose(null)}>
        <DialogHeader>
          <DialogTitle>{promptState.title}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <p className="text-sm leading-relaxed text-muted-foreground">{promptState.message}</p>
          <Input
            ref={promptInputRef}
            value={promptValue}
            onChange={(e) => setPromptValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                handlePromptClose(promptValue)
              }
            }}
            placeholder="请输入..."
          />
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={() => handlePromptClose(null)}>
            {promptState.cancelText}
          </Button>
          <Button onClick={() => handlePromptClose(promptValue)}>
            {promptState.confirmText}
          </Button>
        </DialogFooter>
      </Dialog>
    </MessageBoxContext.Provider>
  )
}

function useMessageBox(): MessageBoxContextValue {
  return React.useContext(MessageBoxContext)
}

export { MessageBoxProvider, useMessageBox }
