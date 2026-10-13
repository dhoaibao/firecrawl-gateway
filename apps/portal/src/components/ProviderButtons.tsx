import { Link2, LogIn } from "lucide-react";
import { Button } from "@firecrawl-gateway/ui/components/button";
import { apiUrl } from "@/lib/api";
import { PROVIDER_LABELS } from "@/lib/format";
import type { ProviderName } from "@/lib/types";

interface ProviderButtonsProps {
  providers: ProviderName[];
  /** Start a link flow for the signed-in user instead of a new sign-in. */
  link?: boolean;
}

/** Plain links: sign-in is a full-page redirect to the provider, not a fetch. */
export function ProviderButtons({ providers, link = false }: ProviderButtonsProps) {
  const Icon = link ? Link2 : LogIn;
  return (
    <div className="flex flex-col gap-2">
      {providers.map((provider) => (
        <Button key={provider} asChild variant="outline" className="h-11 justify-center">
          <a href={apiUrl(`/portal/api/auth/login/${provider}${link ? "?link=1" : ""}`)}>
            <Icon aria-hidden />
            {link ? "Link" : "Continue with"} {PROVIDER_LABELS[provider]}
          </a>
        </Button>
      ))}
    </div>
  );
}
