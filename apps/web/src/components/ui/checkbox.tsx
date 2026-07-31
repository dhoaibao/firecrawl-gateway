import * as React from "react"
import { Check } from "lucide-react"

import { cn } from "@/lib/utils"

const Checkbox = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, ...props }, ref) => (
    <span className="relative inline-flex size-4 shrink-0">
      <input
        ref={ref}
        type="checkbox"
        className={cn(
          "peer absolute inset-0 z-10 size-4 cursor-pointer appearance-none rounded-[4px] border border-white/[0.18] bg-surface-2 outline-none transition-all duration-150 hover:border-info/70 focus-visible:border-info focus-visible:ring-2 focus-visible:ring-ring/40 checked:border-info checked:bg-info disabled:cursor-not-allowed disabled:opacity-40",
          className,
        )}
        {...props}
      />
      <Check
        aria-hidden="true"
        className="pointer-events-none absolute inset-0.5 z-20 hidden size-3 text-info-fg peer-checked:block"
        strokeWidth={3}
      />
    </span>
  ),
)
Checkbox.displayName = "Checkbox"

export { Checkbox }
