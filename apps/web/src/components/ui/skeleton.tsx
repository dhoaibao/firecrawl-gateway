import { cn } from "@/lib/utils"

function Skeleton({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md bg-[hsl(230_9%_16%)]",
        className,
      )}
      {...props}
    >
      <div
        className="absolute inset-0 -translate-x-full animate-[shimmer_2s_infinite] bg-gradient-to-r from-transparent via-white/[0.04] to-transparent"
        aria-hidden="true"
      />
    </div>
  )
}

export { Skeleton }
