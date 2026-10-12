import { createContext, useContext, useCallback, useMemo, type ReactNode } from "react";
import { toast } from "sonner";
import { Toaster } from "@firecrawl-gateway/ui/components/sonner";

interface ToastContextValue {
  addToast: (message: string, type?: "success" | "error") => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const addToast = useCallback((message: string, type: "success" | "error" = "error") => {
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
            toast: "!rounded-lg !border !px-4 !py-3 !shadow-lg !text-sm !font-sans",
            success: "!border-success-muted !bg-success-muted/90 !text-success-fg",
            error: "!border-danger-muted !bg-danger-muted/90 !text-danger-fg",
          },
        }}
      />
    </ToastContext.Provider>
  );
}
