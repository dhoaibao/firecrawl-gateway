import express, { type Request, type RequestHandler, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import path from "node:path";
import type { GatewayConfig } from "./types";
import { pingDatabase } from "./db";
import type { AuditStore } from "./audit-store";
import { createProxyHandler } from "./proxy";
import { createAdminRouter } from "./admin-api";
import { requestLogger, rateLimiter, requestIdMiddleware } from "./middleware";
import { passport } from "./auth/passport";
import { createAuthRouter } from "./auth/routes";
import { requireAuth, requireAdmin, requireOperatorMfa, csrfMiddleware } from "./auth/middleware";
import { createUsersRouter } from "./users/routes";
import { createApiKeysRouter } from "./api-keys/routes";
import { createCredentialsRouter } from "./credentials/routes";
import { createSettingsRouter } from "./settings/routes";
import { rootLogger } from "./logger";
import { healthSchema } from "@firecrawl/contracts";
import { createBrevoWebhookRouter } from "./auth/email";

export type ProxyHandler = (req: Request, res: Response) => Promise<void>;

export interface AppDependencies {
  config: GatewayConfig;
  auditStore: AuditStore;
  handleProxy?: ProxyHandler;
  handlePlaygroundProxy?: ProxyHandler;
  checkDatabase?: () => Promise<boolean>;
  corsOrigin?: string;
  sessionMiddleware?: RequestHandler;
}

export function createApp(dependencies: AppDependencies) {
  const {
    config,
    auditStore,
    checkDatabase = pingDatabase,
    corsOrigin = process.env.CORS_ORIGIN,
    sessionMiddleware,
  } = dependencies;
  const handleProxy = dependencies.handleProxy ?? createProxyHandler({ config, auditStore });
  const handlePlaygroundProxy = dependencies.handlePlaygroundProxy ?? createProxyHandler({
    config,
    auditStore,
    getTrustedUserId: (req) => (req.user as Express.User | undefined)?.id,
    getTrustedAccountId: (req) => (req.user as Express.User | undefined)?.account_id,
  });
  const adminRouter = createAdminRouter(auditStore);
  const app = express();

  app.set("trust proxy", config.trustProxy);

  app.use(helmet());
  const corsOrigins = (corsOrigin || "").split(",").map((origin) => origin.trim()).filter(Boolean);
  app.use(cors({
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    credentials: corsOrigins.length > 0,
  }));
  app.use(compression());

  app.get("/health", (_req, res) => {
    res.json(healthSchema.parse({ status: "ok" }));
  });

  app.use("/api/v1/webhooks", express.json({ limit: "64kb" }), createBrevoWebhookRouter(config));

  app.get("/ready", async (_req, res) => {
    const dbOk = await checkDatabase();
    if (dbOk) {
      res.json(healthSchema.parse({ status: "ready", checks: { database: "ok" } }));
    } else {
      res.status(503).json(healthSchema.parse({
        status: "not_ready",
        checks: { database: "error" },
      }));
    }
  });

  app.use(requestIdMiddleware);

  if (config.authEnabled) {
    if (!sessionMiddleware) {
      throw new Error("sessionMiddleware is required when AUTH_ENABLED=true");
    }
    app.use(sessionMiddleware);
    app.use(passport.initialize());
    app.use(passport.session());
    app.use(csrfMiddleware(corsOrigin));
  }

  app.use(requestLogger);
  app.use(rateLimiter(config.trustProxy));

  if (config.authEnabled) {
    app.use("/admin/api/auth", express.json({ limit: "32kb" }), createAuthRouter(config));
    app.use("/admin/api", requireAuth, adminRouter);
    app.use("/admin/api/users", express.json({ limit: "32kb" }), requireAdmin, requireOperatorMfa, createUsersRouter(config));
    app.use("/admin/api/api-keys", express.json(), requireAuth, createApiKeysRouter());
    app.use("/admin/api/credentials", express.json({ limit: "32kb" }), requireAuth, createCredentialsRouter(config));
    app.use("/admin/api/settings", express.json({ limit: "32kb" }), requireAdmin, requireOperatorMfa, createSettingsRouter(config));

    app.use("/admin/api/playground", requireAuth, async (req, res, next) => {
      if (!/^\/v[12]\//.test(req.url)) {
        res.status(404).json({ success: false, error: "Only /v1/* and /v2/* are supported" });
        return;
      }
      req.originalUrl = req.originalUrl.replace(/^\/admin\/api\/playground/, "") || "/";
      try {
        await handlePlaygroundProxy(req, res);
      } catch (error) {
        next(error);
      }
    });
  }

  const adminUiPath = path.resolve(__dirname, "../../web/dist");
  if (config.authEnabled) {
    app.use("/admin", express.static(adminUiPath));
    app.get("/admin", (_req, res) => {
      res.sendFile(path.join(adminUiPath, "index.html"));
    });
    app.get("/admin/*", (req, res, next) => {
      if (req.path.startsWith("/admin/api/") || req.path === "/admin/api") {
        return next();
      }
      res.sendFile(path.join(adminUiPath, "index.html"));
    });
  } else {
    const respondAdminUiDisabled = (_req: express.Request, res: express.Response) => {
      res.status(404).json({
        success: false,
        error: "Admin UI is unavailable when AUTH_ENABLED=false.",
      });
    };

    app.get("/admin", respondAdminUiDisabled);
    app.get("/admin/*", respondAdminUiDisabled);
  }

  app.use("/e/:endpointId", async (req, res, next) => {
    if (!/^\/v[12]\//.test(req.url)) {
      return next();
    }
    // Express removes the mount path from req.url, which is the exact suffix
    // the upstream receives. Keep the public endpoint ID out of forwarded URLs.
    (req as Request & { tenantEndpointId?: string }).tenantEndpointId = req.params.endpointId;
    try {
      await handleProxy(req, res);
    } catch (error) {
      next(error);
    }
  });

  app.use(async (req, res, next) => {
    if (!/^\/v[12]\//.test(req.path)) {
      return next();
    }
    try {
      await handleProxy(req, res);
    } catch (error) {
      next(error);
    }
  });

  app.use((_req, res) => {
    const handledPaths = config.authEnabled
      ? "/e/:endpointId/v1/*, /e/:endpointId/v2/*, /v1/*, /v2/*, /health, /ready, and /admin"
      : "/e/:endpointId/v1/*, /e/:endpointId/v2/*, /v1/*, /v2/*, /health, and /ready";
    res.status(404).json({
      success: false,
      error: `Only ${handledPaths} are handled.`,
    });
  });

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    rootLogger.error({ err }, "Gateway error");
    if (res.headersSent) return;
    const isDev = process.env.NODE_ENV !== "production";
    const statusCode = (err as Error & { statusCode?: number }).statusCode || 500;
    res.status(statusCode).json({
      success: false,
      error: err.message || "Gateway error",
      ...(isDev ? { stack: err.stack } : {}),
    });
  });

  return app;
}
