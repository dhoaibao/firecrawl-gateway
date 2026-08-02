import { Router } from "express";
import { asyncHandler } from "../infrastructure/http/async-handler";
import { createApiKey, getApiKey, getOwnApiKey, listApiKeys, listOwnApiKeys, revokeApiKey, revokeOwnApiKey, type ApiKeyControllerOptions } from "./controllers";

/**
 * Legacy admin path retained for compatibility. The resources it exposes are
 * gateway tokens: they authenticate to this gateway, never to an upstream.
 */
export interface ApiKeysRouterOptions extends ApiKeyControllerOptions {
  userOnly?: boolean;
}

export function createApiKeysRouter(options: ApiKeysRouterOptions = {}) {
  const router = Router();
  router.get("/", asyncHandler(options.userOnly ? listOwnApiKeys : listApiKeys));
  router.get("/:id", asyncHandler(options.userOnly ? getOwnApiKey : getApiKey));
  router.post("/", asyncHandler((req, res) => createApiKey(req, res, options)));
  router.delete("/:id", asyncHandler(options.userOnly
    ? (req, res) => revokeOwnApiKey(req, res, options)
    : (req, res) => revokeApiKey(req, res, options)));
  return router;
}

export function createUserApiKeysRouter(options: Omit<ApiKeysRouterOptions, "userOnly"> = {}) {
  return createApiKeysRouter({ ...options, userOnly: true, requireReauthentication: true });
}
