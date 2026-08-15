import { Component, type ReactNode, type ErrorInfo } from 'react'
import { useI18n } from '../i18n/index.tsx'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

function FallbackView({ error, onRetry }: { error: Error | null; onRetry: () => void }) {
  const { t } = useI18n()
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8">
      <p className="text-destructive font-medium">{t('tools.errors.pageRenderError')}</p>
      <p className="max-w-md text-center text-sm text-muted-foreground">
        {error?.message}
      </p>
      <button
        onClick={onRetry}
        className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90"
      >
        {t('common.retry')}
      </button>
    </div>
  )
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback
      return (
        <FallbackView
          error={this.state.error}
          onRetry={() => this.setState({ hasError: false, error: null })}
        />
      )
    }
    return this.props.children
  }
}
