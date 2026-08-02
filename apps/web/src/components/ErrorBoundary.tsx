import { Component, type ReactNode } from "react"
import { AlertCircle, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error?: Error
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("ErrorBoundary caught:", error, errorInfo)
  }

  handleReset = () => {
    this.setState({ hasError: false, error: undefined })
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }
      return (
        <div className="flex min-h-screen items-center justify-center bg-background px-4">
          <div className="flex max-w-sm flex-col items-center gap-4 text-center">
            <div className="rounded-full bg-danger-muted/50 p-3">
              <AlertCircle className="size-6 text-danger-fg" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-foreground">Something went wrong</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                The page could not be rendered safely. Reload and try again.
              </p>
            </div>
            <Button onClick={this.handleReset}>
              <RefreshCw className="size-4 mr-1" />
              Reload page
            </Button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
