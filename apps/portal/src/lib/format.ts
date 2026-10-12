const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatDate(value: string | null): string {
  return value ? dateFormat.format(new Date(value)) : "—";
}

export function formatDateTime(value: string | null): string {
  return value ? dateTimeFormat.format(new Date(value)) : "—";
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

export const PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  github: "GitHub",
};
