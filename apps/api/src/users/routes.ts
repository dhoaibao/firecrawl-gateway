import { Router } from "express";
import type { GatewayConfig } from "../types";
import { asyncHandler } from "../infrastructure/http/async-handler";
import { createUsersControllers } from "./controllers";

export function createUsersRouter(config?: GatewayConfig) {
  const router = Router();
  const controllers = createUsersControllers(config);

  router.get("/", asyncHandler(controllers.list));
  router.get("/:id", asyncHandler(controllers.get));
  router.post("/", asyncHandler(controllers.create));
  router.patch("/:id", asyncHandler(controllers.update));
  router.post("/:id/suspend", asyncHandler(controllers.suspend));
  router.post("/:id/block", asyncHandler(controllers.block));
  router.post("/:id/activate", asyncHandler(controllers.activate));
  router.delete("/:id", asyncHandler(controllers.remove));

  return router;
}
