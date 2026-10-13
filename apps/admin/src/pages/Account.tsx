import { useEffect } from "react";
import { KeyRound, ShieldCheck } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@firecrawl-gateway/ui/components/card";
import PageLayout from "@/components/PageLayout";
import { useAuth } from "@/contexts/AuthContext";

export default function Account() {
  const { admin } = useAuth();

  useEffect(() => {
    document.title = "Account — Firecrawl Gateway";
  }, []);

  return (
    <PageLayout title="Account" icon={KeyRound}>
      <div className="grid max-w-5xl gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.65fr)]">
        <Card className="overflow-hidden border-white/[0.06] bg-surface-2 py-0">
          <CardHeader className="border-b border-white/[0.06] bg-surface-3 px-5 py-5">
            <CardTitle className="text-sm font-semibold">Administrator</CardTitle>
            <CardDescription className="mt-1.5">{admin?.email}</CardDescription>
          </CardHeader>
          <CardContent className="px-5 py-5 text-sm text-muted-foreground">
            The administrator email and password are managed through the API environment variables{" "}
            <code>ADMIN_EMAIL</code> and <code>ADMIN_PASSWORD</code>. Restart the API after changing
            them.
          </CardContent>
        </Card>

        <Card className="border-white/[0.06] bg-surface-2 shadow-none">
          <CardHeader>
            <div className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-success-fg" />
              <CardTitle className="text-sm font-semibold">Security checklist</CardTitle>
            </div>
            <CardDescription>Keep your administrator credentials protected.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            {[
              "Use a password you do not reuse elsewhere",
              "Keep ADMIN_PASSWORD private",
              "Restart the API after changing the environment credentials",
            ].map((item) => (
              <div key={item}>{item}</div>
            ))}
          </CardContent>
        </Card>
      </div>
    </PageLayout>
  );
}
