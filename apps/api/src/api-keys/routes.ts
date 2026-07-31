import { Router } from "express";
import type { ApiKey, User } from "../types";
import { decryptApiKey } from "./crypto";
import * as apiKeyService from "./service";

export function createApiKeysRouter() {
  const router = Router();

  router.get("/", async (req, res, next) => {
    try {
      const user = req.user as User;
      const isPlatformAdmin = user.platform_role === "admin" || user.is_admin;
      const keys = await apiKeyService.listApiKeys(isPlatformAdmin ? undefined : user.id);
      res.json({ data: keys.map((key) => sanitizeApiKey(key, key.user_id === user.id)) });
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
        res.status(404).json({ success: false, error: "API key not found" });
        return;
      }
      // Only the key owner can view
      if (key.user_id !== user.id) {
        res.status(403).json({ success: false, error: "Forbidden" });
        return;
      }
      res.json({ data: sanitizeApiKey(key, true) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const user = req.user as User;
      const { name } = req.body;

      if (!name) {
        res.status(400).json({ success: false, error: "name is required" });
        return;
      }

      // Users can only create keys for themselves
      const created = await apiKeyService.createApiKey(user.id, name);
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
        res.status(404).json({ success: false, error: "API key not found" });
        return;
      }
      // Only the key owner can revoke
      if (key.user_id !== user.id) {
        res.status(403).json({ success: false, error: "Forbidden" });
        return;
      }
      const revoked = user.account_id
        ? await apiKeyService.revokeApiKey(req.params.id, user.account_id)
        : await apiKeyService.revokeApiKey(req.params.id);
      if (!revoked) {
        res.status(404).json({ success: false, error: "API key not found" });
        return;
      }
      res.json({ data: sanitizeApiKey(revoked, true) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function sanitizeApiKey(key: ApiKey, canViewSecret: boolean) {
  const { key_hash, key_value, ...rest } = key;
  return canViewSecret && !key.revoked && key_value
    ? { ...rest, key: decryptApiKey(key_value) }
    : rest;
}
