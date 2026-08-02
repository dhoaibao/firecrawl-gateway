import { Router } from "express";
import type { Request, Response } from "express";
import type { GatewayConfig, User } from "../types";
import { recordSecurityEvent } from "../auth/security";
import { verifySensitiveAction } from "../auth/reauth";
import * as credentialRepository from "./repository";

export interface CredentialsRouterDependencies {
  createAccountCredential: typeof credentialRepository.createAccountCredential;
  listAccountCredentialMetadata: typeof credentialRepository.listAccountCredentialMetadata;
  validateAccountCredential: typeof credentialRepository.validateAccountCredential;
  replaceAccountCredential?: typeof credentialRepository.replaceAccountCredential;
  deleteAccountCredential?: typeof credentialRepository.deleteAccountCredential;
}

const defaultDependencies: CredentialsRouterDependencies = {
  createAccountCredential: credentialRepository.createAccountCredential,
  listAccountCredentialMetadata: credentialRepository.listAccountCredentialMetadata,
  validateAccountCredential: credentialRepository.validateAccountCredential,
  replaceAccountCredential: credentialRepository.replaceAccountCredential,
  deleteAccountCredential: credentialRepository.deleteAccountCredential,
};

function accountIdFor(user: User): string | null {
  return user.account_id ?? null;
}

async function requireReauthentication(
  req: Request,
  res: Response,
  user: User,
  config: GatewayConfig,
): Promise<boolean> {
  const result = await verifySensitiveAction(
    user,
    req.body,
    config.authEncryptionKey || process.env.AUTH_ENCRYPTION_KEY || "",
  );
  if (result.ok) return true;
  res.status(401).json({ success: false, error: result.error });
  return false;
}

async function recordCredentialEvent(user: User, req: Request, type: string, credentialId: string): Promise<void> {
  if (user.auth_version === undefined) return;
  await recordSecurityEvent({
    userId: user.id,
    type,
    ip: req.ip,
    userAgent: req.get("user-agent"),
    metadata: { credential_id: credentialId },
  });
}

/** Tenant-managed Firecrawl Cloud credentials. Plaintext values are accepted only on creation. */
export function createCredentialsRouter(
  config: GatewayConfig,
  dependencies: CredentialsRouterDependencies = defaultDependencies,
) {
  const router = Router();
  const encryptionKey = config.providerCredentialsEncryptionKey ?? config.firecrawlKeysEncryptionKey;

  router.get("/", async (req, res, next) => {
    try {
      const accountId = accountIdFor(req.user as User);
      if (!accountId) {
        res.status(403).json({ success: false, error: "An account is required" });
        return;
      }
      res.json({ data: await dependencies.listAccountCredentialMetadata(accountId) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const user = req.user as User;
      const accountId = accountIdFor(user);
      if (!accountId) {
        res.status(403).json({ success: false, error: "An account is required" });
        return;
      }
      if (user.email_verified_at === null) {
        res.status(403).json({ success: false, error: "Email verification is required" });
        return;
      }
      if (typeof req.body?.value !== "string" || !req.body.value.trim()) {
        res.status(400).json({ success: false, error: "value is required" });
        return;
      }
      if (!(await requireReauthentication(req, res, user, config))) return;
      const credential = await dependencies.createAccountCredential(accountId, {
        value: req.body.value.trim(),
        purpose: "firecrawl_cloud",
        keyVersion: 1,
      }, encryptionKey);
      const validated = await dependencies.validateAccountCredential(
        accountId,
        credential.id,
        encryptionKey,
        config.cloudBaseUrl,
      );
      await recordCredentialEvent(user, req, "credential_created", credential.id);
      res.status(201).json({ data: validated ?? credential });
    } catch (error) {
      next(error);
    }
  });

  router.put("/:id", async (req, res, next) => {
    try {
      const user = req.user as User;
      const accountId = accountIdFor(user);
      if (!accountId) {
        res.status(403).json({ success: false, error: "An account is required" });
        return;
      }
      if (user.email_verified_at === null) {
        res.status(403).json({ success: false, error: "Email verification is required" });
        return;
      }
      if (typeof req.body?.value !== "string" || !req.body.value.trim()) {
        res.status(400).json({ success: false, error: "value is required" });
        return;
      }
      if (!(await requireReauthentication(req, res, user, config))) return;
      const replacement = await dependencies.replaceAccountCredential?.(
        accountId,
        req.params.id,
        { value: req.body.value.trim(), purpose: "firecrawl_cloud", keyVersion: 1 },
        encryptionKey,
      );
      if (!replacement) {
        res.status(404).json({ success: false, error: "Credential not found" });
        return;
      }
      const validated = await dependencies.validateAccountCredential(
        accountId,
        replacement.id,
        encryptionKey,
        config.cloudBaseUrl,
      );
      await recordCredentialEvent(user, req, "credential_replaced", replacement.id);
      res.status(201).json({ data: validated ?? replacement });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/:id", async (req, res, next) => {
    try {
      const user = req.user as User;
      const accountId = accountIdFor(user);
      if (!accountId) {
        res.status(403).json({ success: false, error: "An account is required" });
        return;
      }
      if (!(await requireReauthentication(req, res, user, config))) return;
      const deleted = await dependencies.deleteAccountCredential?.(accountId, req.params.id);
      if (!deleted) {
        res.status(404).json({ success: false, error: "Credential not found" });
        return;
      }
      await recordCredentialEvent(user, req, "credential_deleted", req.params.id);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.post("/:id/validate", async (req, res, next) => {
    try {
      const user = req.user as User;
      const accountId = accountIdFor(user);
      if (!accountId) {
        res.status(403).json({ success: false, error: "An account is required" });
        return;
      }
      if (!(await requireReauthentication(req, res, user, config))) return;
      const credential = await dependencies.validateAccountCredential(
        accountId,
        req.params.id,
        encryptionKey,
        config.cloudBaseUrl,
      );
      if (!credential) {
        res.status(404).json({ success: false, error: "Credential not found" });
        return;
      }
      await recordCredentialEvent(req.user as User, req, "credential_validated", req.params.id);
      res.json({ data: credential });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
