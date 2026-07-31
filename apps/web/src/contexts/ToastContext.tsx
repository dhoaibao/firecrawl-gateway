import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from "react"
import { ToastStack } from "@/components/ToastStack"

export interface Toast {
  id: number
  message: string
  type: "success" | "error"
}

interface ToastContextValue {
  toasts: Toast[]
  addToast: (message: string, type?: Toast["type"]) => void
  removeToast: (id: number) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function useToastContext(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) {
    throw new Error("useToastContext must be used within a ToastProvider")
  }
  return ctx
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const timersRef = useRef<Map<number, number>>(new Map())

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
    const timer = timersRef.current.get(id)
    if (timer) {
      window.clearTimeout(timer)
      timersRef.current.delete(id)
    }
  }, [])

  const addToast = useCallback((message: string, type: Toast["type"] = "error") => {
    const id = Date.now() + Math.random()
    setToasts((prev) => [...prev, { id, message, type }])
    const timer = window.setTimeout(() => {
      removeToast(id)
    }, 4000)
    timersRef.current.set(id, timer)
  }, [removeToast])

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast }}>
      {children}
      <ToastStack toasts={toasts} onRemove={removeToast} />
    </ToastContext.Provider>
  )
}
