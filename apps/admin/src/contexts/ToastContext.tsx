import { createContext, useContext, useCallback, useMemo, type ReactNode } from "react";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";

export type ToastType = "success" | "error";

interface ToastContextValue {
  addToast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToastContext(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToastContext must be used within a ToastProvider");
  }
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const addToast = useCallback((message: string, type: ToastType = "error") => {
    if (type === "success") toast.success(message);
    else toast.error(message);
  }, []);
  const value = useMemo(() => ({ addToast }), [addToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <Toaster
        position="top-center"
        duration={4000}
        closeButton
        toastOptions={{
          classNames: {
            toast: "!rounded-lg !border !px-4 !py-3 !shadow-lg !backdrop-blur !text-sm !font-sans",
            success: "!border-success-muted !bg-success-muted/90 !text-success-fg",
            error: "!border-danger-muted !bg-danger-muted/90 !text-danger-fg",
            closeButton: "!border-white/[0.08] !bg-surface-3 !text-foreground",
          },
        }}
      />
    </ToastContext.Provider>
  );
}
