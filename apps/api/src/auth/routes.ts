import { Router } from "express";
import bcrypt from "bcrypt";
import type { GatewayConfig, User } from "../types";
import { passport } from "./passport";
import { requireAuth } from "./middleware";
import type { AuthenticatedRequest } from "./middleware";
import { serializeUser } from "../users/serialization";
import { authenticatedUserSchema } from "@firecrawl/contracts";
import * as userService from "../users/service";
import { getMfaState, beginMfaSetup, verifyMfaCode, disableMfa, createRecoveryCodes, consumeRecoveryCode, createSessionRecord, markSessionMfaVerified, revokeSession, revokeSessionById, revokeAllSessions, listSessions } from "./security";
import { GENERIC_AUTH_MESSAGE, registerUser, requestEmailVerification, consumeEmailVerification, requestPasswordReset, resetPassword, requestEmailChange } from "./service";
import { hashPassword, validatePassword } from "./password";

const attemptTracker = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 8;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_TRACKED_ATTEMPTS = 10_000;

function configValue(config: GatewayConfig | undefined, key: "authEncryptionKey"): string {
  return config?.[key] || process.env.AUTH_ENCRYPTION_KEY || "";
}

function clientBaseUrl(config: GatewayConfig | undefined): string {
  if (!config?.publicAppUrl) throw new Error("PUBLIC_APP_URL must be configured before sending authentication emails");
  return config.publicAppUrl;
}

function pruneExpiredAttempts(now: number): void {
  for (const [key, entry] of attemptTracker) {
    if (entry.resetAt <= now) attemptTracker.delete(key);
  }
}

function attemptAllowed(key: string): boolean {
  const now = Date.now();
  const current = attemptTracker.get(key);
  if (!current || current.resetAt <= now) {
    if (current) attemptTracker.delete(key);
    if (attemptTracker.size >= MAX_TRACKED_ATTEMPTS) pruneExpiredAttempts(now);
    if (attemptTracker.size >= MAX_TRACKED_ATTEMPTS) return false;
    attemptTracker.set(key, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
    return true;
  }
  current.count += 1;
  return current.count <= MAX_ATTEMPTS;
}

async function establishLogin(req: AuthenticatedRequest, user: User, mfaVerified = false): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    req.logIn(user, (error) => error ? reject(error) : resolve());
  });
  if (req.sessionID && user.auth_version !== undefined) {
    await createSessionRecord({ sessionId: req.sessionID, userId: user.id, authVersion: user.auth_version, mfaVerified, ip: req.ip, userAgent: req.get("user-agent") });
  }
}

export function createAuthRouter(config?: GatewayConfig) {
  const router = Router();
  const encryptionKey = configValue(config, "authEncryptionKey");

  router.post("/login", (req: AuthenticatedRequest, res, next) => {
    passport.authenticate("local", async (err: Error | null, user: Express.User | false) => {
      try {
        if (err) return next(err);
        if (!user) return res.status(401).json({ success: false, error: "Invalid email or password" });
        const typedUser = user as User;
        const mfa = await getMfaState(typedUser.id);
        await new Promise<void>((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
        if (mfa.enabled) {
          const session = req.session as typeof req.session & { pendingMfaUserId?: string; pendingMfaAt?: number };
          session.pendingMfaUserId = typedUser.id;
          session.pendingMfaAt = Date.now();
          await new Promise<void>((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
          return res.json({ success: true, mfa_required: true });
        }
        await establishLogin(req, typedUser);
        await new Promise<void>((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
        return res.json({ success: true, data: authenticatedUserSchema.parse(serializeUser(typedUser)) });
      } catch (error) {
        return next(error);
      }
    })(req, res, next);
  });

  router.post("/login/mfa", async (req: AuthenticatedRequest, res, next) => {
    try {
      const session = req.session as typeof req.session & { pendingMfaUserId?: string; pendingMfaAt?: number };
      if (!session.pendingMfaUserId || !session.pendingMfaAt || Date.now() - session.pendingMfaAt > 10 * 60 * 1000) {
        res.status(401).json({ success: false, error: "Invalid or expired MFA challenge" });
        return;
      }
      const key = `${req.ip}:${session.pendingMfaUserId}`;
      if (!attemptAllowed(key)) {
        res.status(429).json({ success: false, error: "Too many authentication attempts" });
        return;
      }
      const valid = req.body.recovery_code
        ? await consumeRecoveryCode(session.pendingMfaUserId, String(req.body.recovery_code))
        : await verifyMfaCode(session.pendingMfaUserId, String(req.body.code || ""), encryptionKey);
      if (!valid) {
        res.status(401).json({ success: false, error: "Invalid authentication code" });
        return;
      }
      const user = await userService.getUserById(session.pendingMfaUserId);
      if (!user) {
        res.status(401).json({ success: false, error: "Invalid authentication code" });
        return;
      }
      await new Promise<void>((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
      await establishLogin(req, user, true);
      await new Promise<void>((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
      res.json({ success: true, data: authenticatedUserSchema.parse(serializeUser(user)) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/logout", async (req, res, next) => {
    try {
      if (req.sessionID) await revokeSession(req.sessionID);
      req.logout((error) => {
        if (error) return next(error);
        req.session.destroy((destroyError) => {
          if (destroyError) return next(destroyError);
          res.clearCookie(process.env.NODE_ENV === "production" ? "__Host-firecrawl.sid" : "firecrawl.sid", { path: "/" });
          res.json({ success: true });
        });
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/me", requireAuth, (req: AuthenticatedRequest, res) => {
    res.json({ data: authenticatedUserSchema.parse(serializeUser(req.user as User)) });
  });

  router.get("/csrf", (req, res) => {
    const session = req.session as typeof req.session & { csrfToken?: string };
    session.csrfToken ??= require("node:crypto").randomBytes(32).toString("base64url");
    res.json({ data: { token: session.csrfToken } });
  });

  router.post("/register", async (req, res, next) => {
    try {
      if (!config?.registrationEnabled) {
        res.status(202).json({ success: true, message: GENERIC_AUTH_MESSAGE });
        return;
      }
      const email = typeof req.body.email === "string" ? req.body.email.trim() : "";
      const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
      const password = req.body.password;
      const passwordError = validatePassword(password);
      if (!email || !name || passwordError) {
        res.status(400).json({ success: false, error: passwordError || "Email and name are required" });
        return;
      }
      if (!attemptAllowed(`${req.ip}:${email.toLowerCase()}`)) {
        res.status(429).json({ success: false, error: "Too many requests" });
        return;
      }
      await registerUser({ email, name, password, encryptionKey, baseUrl: clientBaseUrl(config), ip: req.ip, userAgent: req.get("user-agent") });
      res.status(202).json({ success: true, message: GENERIC_AUTH_MESSAGE });
    } catch (error) {
      next(error);
    }
  });

  router.post("/verification/request", async (req, res, next) => {
    try {
      if (typeof req.body.email === "string" && attemptAllowed(`${req.ip}:${req.body.email.toLowerCase()}`)) {
        await requestEmailVerification({ email: req.body.email, encryptionKey, baseUrl: clientBaseUrl(config) });
      }
      res.status(202).json({ success: true, message: GENERIC_AUTH_MESSAGE });
    } catch (error) { next(error); }
  });

  router.post("/verification/consume", async (req, res, next) => {
    try {
      const success = typeof req.body.token === "string" && await consumeEmailVerification(req.body.token);
      res.status(success ? 200 : 400).json({ success, ...(success ? {} : { error: "Invalid or expired verification token" }) });
    } catch (error) { next(error); }
  });

  router.post("/password/forgot", async (req, res, next) => {
    try {
      if (typeof req.body.email === "string" && attemptAllowed(`${req.ip}:${req.body.email.toLowerCase()}`)) {
        await requestPasswordReset({ email: req.body.email, encryptionKey, baseUrl: clientBaseUrl(config) });
      }
      res.status(202).json({ success: true, message: GENERIC_AUTH_MESSAGE });
    } catch (error) { next(error); }
  });

  router.post("/password/reset", async (req, res, next) => {
    try {
      const error = validatePassword(req.body.new_password);
      if (error || typeof req.body.token !== "string") {
        res.status(400).json({ success: false, error: error || "Token is required" });
        return;
      }
      const success = await resetPassword(req.body.token, req.body.new_password, encryptionKey);
      res.status(success ? 200 : 400).json({ success, ...(success ? {} : { error: "Invalid or expired reset token" }) });
    } catch (error) { next(error); }
  });

  router.post("/email", requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      const user = req.user as User;
      const email = typeof req.body.email === "string" ? req.body.email.trim() : "";
      if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
        res.status(400).json({ success: false, error: "A valid email is required" });
        return;
      }
      if (!(await bcrypt.compare(String(req.body.current_password || ""), user.password_hash))) {
        res.status(401).json({ success: false, error: "Current password is incorrect" });
        return;
      }
      const mfa = user.auth_version === undefined ? { enabled: false, verified: false } : await getMfaState(user.id);
      if (mfa.enabled && !(await verifyMfaCode(user.id, String(req.body.mfa_code || ""), encryptionKey))) {
        res.status(401).json({ success: false, error: "MFA is required" });
        return;
      }
      await requestEmailChange({ userId: user.id, email, encryptionKey, baseUrl: clientBaseUrl(config) });
      res.status(202).json({ success: true, message: GENERIC_AUTH_MESSAGE });
    } catch (error) { next(error); }
  });

  router.post("/password", requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      const { current_password, new_password } = req.body;
      const passwordError = validatePassword(new_password);
      if (typeof current_password !== "string" || passwordError) {
        res.status(400).json({ success: false, error: passwordError || "Current password and new password are required" });
        return;
      }
      const user = req.user as User;
      if (!(await bcrypt.compare(current_password, user.password_hash))) {
        res.status(401).json({ success: false, error: "Current password is incorrect" });
        return;
      }
      const mfa = user.auth_version === undefined ? { enabled: false, verified: false } : await getMfaState(user.id);
      if (mfa.enabled && !(await verifyMfaCode(user.id, String(req.body.mfa_code || ""), encryptionKey))) {
        res.status(401).json({ success: false, error: "MFA is required" });
        return;
      }
      await userService.updateUser(user.id, { password_hash: await hashPassword(new_password) });
      if (user.auth_version !== undefined) await revokeAllSessions(user.id);
      res.json({ success: true });
    } catch (error) { next(error); }
  });

  router.get("/mfa", requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      res.json({ data: await getMfaState((req.user as User).id) });
    } catch (error) { next(error); }
  });

  router.post("/mfa/setup", requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      const user = req.user as User;
      const existing = await getMfaState(user.id);
      if (existing.enabled) {
        if (!(await bcrypt.compare(String(req.body.current_password || ""), user.password_hash))) {
          res.status(401).json({ success: false, error: "Current password is incorrect" });
          return;
        }
        const verified = req.body.recovery_code
          ? await consumeRecoveryCode(user.id, String(req.body.recovery_code))
          : await verifyMfaCode(user.id, String(req.body.mfa_code || ""), encryptionKey);
        if (!verified) {
          res.status(401).json({ success: false, error: "MFA is required" });
          return;
        }
      }
      const result = await beginMfaSetup(user.id, user.email, encryptionKey);
      res.json({ data: result });
    } catch (error) { next(error); }
  });

  router.post("/mfa/enable", requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      const user = req.user as User;
      if (!(await verifyMfaCode(user.id, String(req.body.code || ""), encryptionKey, true))) {
        res.status(401).json({ success: false, error: "Invalid authentication code" });
        return;
      }
      const codes = await createRecoveryCodes(user.id);
      if (req.sessionID && user.auth_version !== undefined) {
        await markSessionMfaVerified(req.sessionID, user.id, user.auth_version);
      }
      res.json({ success: true, recovery_codes: codes });
    } catch (error) { next(error); }
  });

  router.post("/mfa/disable", requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      const user = req.user as User;
      if (!(await bcrypt.compare(String(req.body.current_password || ""), user.password_hash))) {
        res.status(401).json({ success: false, error: "Current password is incorrect" });
        return;
      }
      const verified = req.body.recovery_code
        ? await consumeRecoveryCode(user.id, String(req.body.recovery_code))
        : await verifyMfaCode(user.id, String(req.body.mfa_code || ""), encryptionKey);
      if (!verified) {
        res.status(401).json({ success: false, error: "MFA is required" });
        return;
      }
      await disableMfa(user.id);
      await revokeAllSessions(user.id);
      res.json({ success: true });
    } catch (error) { next(error); }
  });

  router.get("/sessions", requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try { res.json({ data: await listSessions((req.user as User).id) }); } catch (error) { next(error); }
  });

  router.delete("/sessions/:id", requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      // Inventory IDs are opaque database identifiers, never raw session IDs.
      await revokeSessionById(String(req.params.id), (req.user as User).id);
      res.json({ success: true });
    } catch (error) { next(error); }
  });

  return router;
}
