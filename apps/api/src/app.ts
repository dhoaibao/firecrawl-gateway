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
import { createOperatorRouter } from "./operator-api";
import { localRateLimitStore, requestLogger, rateLimiter, requestIdMiddleware, type RateLimitStore } from "./middleware";
import { passport } from "./auth/passport";
import { createAuthRouter } from "./auth/routes";
import { requireAuth, requireAdmin, requireOperatorMfa, csrfMiddleware } from "./auth/middleware";
import { createUsersRouter } from "./users/routes";
import { createApiKeysRouter, createUserApiKeysRouter } from "./api-keys/routes";
import { createCredentialsRouter } from "./credentials/routes";
import { createSettingsRouter } from "./settings/routes";
import { createQuotaRouter } from "./quota/routes";
import { errorHandler, notFoundHandler } from "./infrastructure/http/error-handler";
import { healthSchema } from "@firecrawl/contracts";
import { createBrevoWebhookRouter } from "./auth/email";
import { createUserPortalRouter } from "./app-api";

export type ProxyHandler = (req: Request, res: Response) => Promise<void>;

export interface AppDependencies {
  config: GatewayConfig;
  auditStore: AuditStore;
  handleProxy?: ProxyHandler;
  handlePlaygroundProxy?: ProxyHandler;
  checkDatabase?: () => Promise<boolean>;
  corsOrigin?: string;
  sessionMiddleware?: RequestHandler;
  rateLimitStore?: RateLimitStore;
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
  // The browser session protects the playground page, but the proxy still
  // requires a gateway Bearer token so token ownership and scopes are enforced.
  const handlePlaygroundProxy = dependencies.handlePlaygroundProxy ?? createProxyHandler({ config, auditStore });
  const userTokenPolicy = {
    maxLifetimeSeconds: (config.gatewayTokenMaxLifetimeDays ?? 365) * 24 * 60 * 60,
    authEncryptionKey: config.authEncryptionKey,
  };
  const adminRouter = createAdminRouter(auditStore);
  const app = express();
  const corsOrigins = (corsOrigin || "").split(",").map((origin) => origin.trim()).filter(Boolean);

  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'", ...corsOrigins],
        fontSrc: ["'self'", "data:"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:", "blob:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
      },
    },
  }));
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
  app.use(rateLimiter(config.trustProxy, dependencies.rateLimitStore ?? localRateLimitStore));

  if (config.authEnabled) {
    const authRouter = createAuthRouter(config);
    app.use("/api/v1/auth", express.json({ limit: "32kb" }), authRouter);
    app.use("/admin/api/auth", express.json({ limit: "32kb" }), authRouter);
    // New operator boundary. The legacy /admin/api routes remain only for the
    // compatibility window and are not used by the operator console.
    app.use("/api/v1/admin", express.json({ limit: "64kb" }), requireAuth, requireAdmin, createOperatorRouter(config, checkDatabase));
    app.use("/admin/api", requireAuth, adminRouter);
    app.use("/admin/api/users", express.json({ limit: "32kb" }), requireAdmin, requireOperatorMfa, createUsersRouter(config));
    app.use("/admin/api/api-keys", express.json(), requireAuth, createApiKeysRouter({
      requireReauthentication: true,
      authEncryptionKey: config.authEncryptionKey,
      maxLifetimeSeconds: userTokenPolicy.maxLifetimeSeconds,
    }));
    app.use("/admin/api/credentials", express.json({ limit: "32kb" }), requireAuth, createCredentialsRouter(config));
    app.use("/admin/api/settings", express.json({ limit: "32kb" }), requireAdmin, requireOperatorMfa, createSettingsRouter(config));
    app.use("/admin/api/quota", express.json({ limit: "32kb" }), requireAdmin, requireOperatorMfa, createQuotaRouter());

    app.use("/api/v1/app/tokens", express.json({ limit: "32kb" }), requireAuth, createUserApiKeysRouter(userTokenPolicy));
    app.use("/api/v1/app/credentials", express.json({ limit: "32kb" }), requireAuth, createCredentialsRouter(config));
    app.use("/api/v1/app/playground", requireAuth, async (req, res, next) => {
      if (!/^\/v[12]\//.test(req.url)) {
        res.status(404).json({ success: false, error: "Only /v1/* and /v2/* are supported" });
        return;
      }
      req.originalUrl = req.originalUrl.replace(/^\/api\/v1\/app\/playground/, "") || "/";
      try {
        await handlePlaygroundProxy(req, res);
      } catch (error) {
        next(error);
      }
    });
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
    app.use("/api/v1/app", requireAuth, createUserPortalRouter(config));
  }

  const webUiPath = path.resolve(__dirname, "../../web/dist");
  if (config.authEnabled) {
    app.use(express.static(webUiPath));
    const serveWebUi = (_req: express.Request, res: express.Response) => {
      res.sendFile(path.join(webUiPath, "index.html"));
    };
    // Only application route trees receive the SPA document. API, tenant,
    // health, and readiness paths continue to reach their real handlers/404s.
    app.get([
      "/",
      "/login",
      "/register",
      "/verify-email",
      "/forgot-password",
      "/reset-password",
      "/app",
      "/app/*",
      "/admin",
      "/admin/*",
    ], (req, res, next) => {
      if (req.path.startsWith("/admin/api/") || req.path === "/admin/api" || req.path.startsWith("/api/")) {
        return next();
      }
      return serveWebUi(req, res);
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

  app.use(notFoundHandler(config));
  app.use(errorHandler);

  return app;
}
