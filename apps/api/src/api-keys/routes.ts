import { Router } from "express";
import { asyncHandler } from "../infrastructure/http/async-handler";
import { createApiKey, getApiKey, listApiKeys, revokeApiKey } from "./controllers";

/**
 * Legacy admin path retained for compatibility. The resources it exposes are
 * gateway tokens: they authenticate to this gateway, never to an upstream.
 */
export function createApiKeysRouter() {
  const router = Router();
  router.get("/", asyncHandler(listApiKeys));
  router.get("/:id", asyncHandler(getApiKey));
  router.post("/", asyncHandler(createApiKey));
  router.delete("/:id", asyncHandler(revokeApiKey));
  return router;
}
