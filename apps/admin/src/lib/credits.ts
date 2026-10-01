import type { CreditUsageItem } from "@/types";

const MS_PER_DAY = 86_400_000;

/** Mirrors the API's `creditKeyPrefix` so usage rows can be matched to keys by identity, not position. */
export function creditKeyPrefix(apiKey: string): string {
  return `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`;
}

/**
 * Mirrors the gateway's cloud key selection rule: earliest renewal day (UTC)
 * first, then most remaining credits; exact ties are picked at random by the
 * gateway. Returns the key prefixes currently first in line, or an empty set
 * when fewer than two keys are usable (a single key has no meaningful order).
 */
export function nextUpPrefixes(items: CreditUsageItem[]): Set<string> {
  const usable = items.filter(
    (item) => !item.error && typeof item.remainingCredits === "number" && item.remainingCredits > 0,
  );
  if (usable.length < 2) return new Set();

  const rank = (item: CreditUsageItem): [number, number] => {
    const renewsAt = item.billingPeriodEnd ? Date.parse(item.billingPeriodEnd) : Number.NaN;
    const day = Number.isFinite(renewsAt) ? Math.floor(renewsAt / MS_PER_DAY) : Infinity;
    return [day, item.remainingCredits ?? 0];
  };
  const better = (a: [number, number], b: [number, number]) =>
    a[0] < b[0] || (a[0] === b[0] && a[1] > b[1]);

  let best = rank(usable[0]);
  for (const item of usable) {
    const r = rank(item);
    if (better(r, best)) best = r;
  }
  return new Set(
    usable
      .filter((item) => {
        const r = rank(item);
        return r[0] === best[0] && r[1] === best[1];
      })
      .map((item) => item.keyPrefix),
  );
}
