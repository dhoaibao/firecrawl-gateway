import { describe, expect, it } from "vitest";
import { BadRequestException, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { OperatorReasonGuard, OperatorStepUpGuard, PlatformAdminGuard } from "./operator.guards";

function context(request: Record<string, unknown>) {
  return { switchToHttp: () => ({ getRequest: () => request }) } as never;
}

describe("native operator authorization guards", () => {
  it("requires an authenticated platform administrator", () => {
    const guard = new PlatformAdminGuard();
    expect(() => guard.canActivate(context({}))).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context({ authUser: { id: "user-1", is_admin: false } }))).toThrow(ForbiddenException);
    expect(guard.canActivate(context({ authUser: { id: "user-1", is_admin: true } }))).toBe(true);
  });

  it("requires recent step-up and a bounded mutation reason", () => {
    const guard = new OperatorStepUpGuard();
    const base = { url: "/api/v1/admin/accounts/account-1/suspend", session: { operatorStepUpAt: Date.now() }, body: { reason: "safety review" } };
    expect(guard.canActivate(context(base))).toBe(true);
    expect(() => guard.canActivate(context({ ...base, session: {} }))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(context({ ...base, body: { reason: "" } }))).toThrow(BadRequestException);
    expect(() => guard.canActivate(context({ ...base, body: { reason: "x".repeat(501) } }))).toThrow(BadRequestException);
  });

  it("keeps the compatibility admin path available while requiring reasons on native mutations", () => {
    const stepUp = new OperatorStepUpGuard();
    expect(stepUp.canActivate(context({ url: "/admin/api/users", body: {} }))).toBe(true);
    expect(() => new OperatorReasonGuard().canActivate(context({ body: {} }))).toThrow(BadRequestException);
  });
});
