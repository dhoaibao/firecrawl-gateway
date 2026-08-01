import { Router } from "express";
import type { GatewayConfig, User } from "../types";
import * as credentialRepository from "./repository";

export interface CredentialsRouterDependencies {
  createAccountCredential: typeof credentialRepository.createAccountCredential;
  listAccountCredentialMetadata: typeof credentialRepository.listAccountCredentialMetadata;
  validateAccountCredential: typeof credentialRepository.validateAccountCredential;
}

const defaultDependencies: CredentialsRouterDependencies = {
  createAccountCredential: credentialRepository.createAccountCredential,
  listAccountCredentialMetadata: credentialRepository.listAccountCredentialMetadata,
  validateAccountCredential: credentialRepository.validateAccountCredential,
};

function accountIdFor(user: User): string | null {
  return user.account_id ?? null;
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
      res.status(201).json({ data: validated ?? credential });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:id/validate", async (req, res, next) => {
    try {
      const accountId = accountIdFor(req.user as User);
      if (!accountId) {
        res.status(403).json({ success: false, error: "An account is required" });
        return;
      }
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
      res.json({ data: credential });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
