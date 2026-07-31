import { useToastContext } from "@/contexts/ToastContext"

export { type Toast } from "@/contexts/ToastContext"

export function useToast() {
  return useToastContext()
}
