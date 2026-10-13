import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@firecrawl-gateway/ui/components/button";

interface CopyButtonProps {
  value: string;
  label?: string;
  variant?: "outline" | "ghost" | "secondary";
}

/** Copies `value` to the clipboard and confirms in place; falls back silently when blocked. */
export function CopyButton({ value, label = "Copy", variant = "outline" }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Button type="button" variant={variant} size="sm" onClick={() => void copy()}>
      {copied ? <Check className="text-success" /> : <Copy />}
      <span aria-live="polite">{copied ? "Copied" : label}</span>
    </Button>
  );
}
