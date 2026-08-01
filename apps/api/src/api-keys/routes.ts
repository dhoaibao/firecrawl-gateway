import { Router } from "express";
import type { GatewayToken, User } from "../types";
import * as apiKeyService from "./service";

/**
 * Legacy admin path retained for compatibility. The resources it exposes are
 * gateway tokens: they authenticate to this gateway, never to an upstream.
 */
export function createApiKeysRouter() {
  const router = Router();

  router.get("/", async (req, res, next) => {
    try {
      const user = req.user as User;
      const isPlatformAdmin = user.platform_role === "admin" || user.is_admin;
      const keys = await apiKeyService.listApiKeys(isPlatformAdmin ? undefined : user.id);
      res.json({ data: keys.map(sanitizeGatewayToken) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:id", async (req, res, next) => {
    try {
      const user = req.user as User;
      const key = user.account_id
        ? await apiKeyService.getApiKeyById(req.params.id, user.account_id)
        : await apiKeyService.getApiKeyById(req.params.id);
      if (!key) {
        res.status(404).json({ success: false, error: "Gateway token not found" });
        return;
      }
      if (key.user_id !== user.id) {
        res.status(403).json({ success: false, error: "Forbidden" });
        return;
      }
      res.json({ data: sanitizeGatewayToken(key) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const user = req.user as User;
      const { name, scopes, expiresAt, inactivityTimeoutSeconds } = req.body;
      if (typeof name !== "string" || !name.trim()) {
        res.status(400).json({ success: false, error: "name is required" });
        return;
      }
      if (scopes !== undefined && (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string"))) {
        res.status(400).json({ success: false, error: "scopes must be an array of strings" });
        return;
      }
      if (expiresAt !== undefined && (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt)))) {
        res.status(400).json({ success: false, error: "expiresAt must be an ISO timestamp" });
        return;
      }
      if (inactivityTimeoutSeconds !== undefined && (!Number.isInteger(inactivityTimeoutSeconds) || inactivityTimeoutSeconds <= 0)) {
        res.status(400).json({ success: false, error: "inactivityTimeoutSeconds must be a positive integer" });
        return;
      }
      if (user.email_verified_at === null) {
        res.status(403).json({ success: false, error: "Email verification is required" });
        return;
      }
      const created = await apiKeyService.createApiKey(user.id, name.trim(), {
        scopes,
        expiresAt: expiresAt ?? null,
        inactivityTimeoutSeconds: inactivityTimeoutSeconds ?? null,
      });
      res.status(201).json({ data: created });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/:id", async (req, res, next) => {
    try {
      const user = req.user as User;
      const key = user.account_id
        ? await apiKeyService.getApiKeyById(req.params.id, user.account_id)
        : await apiKeyService.getApiKeyById(req.params.id);
      if (!key) {
        res.status(404).json({ success: false, error: "Gateway token not found" });
        return;
      }
      if (key.user_id !== user.id) {
        res.status(403).json({ success: false, error: "Forbidden" });
        return;
      }
      const revoked = user.account_id
        ? await apiKeyService.revokeApiKey(req.params.id, user.account_id)
        : await apiKeyService.revokeApiKey(req.params.id);
      if (!revoked) {
        res.status(404).json({ success: false, error: "Gateway token not found" });
        return;
      }
      res.json({ data: sanitizeGatewayToken(revoked) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function sanitizeGatewayToken(token: GatewayToken) {
  const { key_hash: _keyHash, key_value: _legacyCiphertext, ...safe } = token;
  return safe;
}
