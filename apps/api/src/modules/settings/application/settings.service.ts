import { BadRequestException, Injectable } from "@nestjs/common";
import { routeModeSchema } from "@firecrawl/contracts";
import { Prisma } from "@prisma/client";
import { TransactionService } from "../../../core/database/transaction.service";

const allowedKeys = new Set(["api_key_inactivity_revoke_days", "default_route_mode", "self_hosted_firecrawl_url"]);
const settingSelect = Prisma.validator<Prisma.SettingSelect>()({ key: true, value: true, updatedAt: true });

@Injectable()
export class SettingsService {
  constructor(private readonly transactions: TransactionService) {}

  async list() { const rows = await this.transactions.runAsOperator((tx) => tx.setting.findMany({ orderBy: { key: "asc" }, select: settingSelect })); return Object.fromEntries(rows.map((row) => [row.key, parseValue(row.key, row.value)])); }
  async routing() { const rows = await this.transactions.runAsOperator((tx) => tx.setting.findMany({ where: { key: { in: ["default_route_mode", "self_hosted_firecrawl_url"] } }, select: settingSelect })); const values = Object.fromEntries(rows.map((row) => [row.key, row.value])); return { defaultRouteMode: typeof values.default_route_mode === "string" ? values.default_route_mode : "cloud-first", selfHostedUrl: typeof values.self_hosted_firecrawl_url === "string" ? values.self_hosted_firecrawl_url : "" }; }

  async update(input: Record<string, unknown>) {
    const result: Record<string, unknown> = {};
    await this.transactions.runAsOperator(async (tx) => {
      for (const [key, raw] of Object.entries(input)) {
        if (!allowedKeys.has(key)) throw new BadRequestException(`Invalid setting key: ${key}`);
        const value = normalizeValue(key, raw);
        const row = await tx.setting.upsert({ where: { key }, create: { key, value }, update: { value, updatedAt: new Date() }, select: settingSelect });
        result[key] = parseValue(row.key, row.value);
      }
    });
    return result;
  }
}

function normalizeValue(key: string, raw: unknown): string {
  if (key === "default_route_mode") { if (typeof raw !== "string" || !routeModeSchema.options.includes(raw as never)) throw new BadRequestException("default_route_mode is invalid"); return raw; }
  if (key === "api_key_inactivity_revoke_days") { const value = Number(raw); if (!Number.isFinite(value) || value < 0) throw new BadRequestException("api_key_inactivity_revoke_days must be a non-negative number"); return String(value); }
  if (key === "self_hosted_firecrawl_url") { const value = String(raw ?? "").trim(); if (!value) return ""; let url: URL; try { url = new URL(value); } catch { throw new BadRequestException("self_hosted_firecrawl_url must be a valid HTTP(S) URL"); } if (!/^https?:$/.test(url.protocol)) throw new BadRequestException("self_hosted_firecrawl_url must be a valid HTTP(S) URL"); return url.toString().replace(/\/+$/, ""); }
  throw new BadRequestException(`Invalid setting key: ${key}`);
}
function parseValue(key: string, value: string): unknown { return key === "api_key_inactivity_revoke_days" ? Number(value) : value; }
