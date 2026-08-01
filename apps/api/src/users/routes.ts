import { Router } from "express";
import type { GatewayConfig, User } from "../types";
import * as userService from "./service";
import { serializeUser } from "./serialization";
import { registerUser } from "../auth/service";
import { hashPassword, validatePassword } from "../auth/password";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createUsersRouter(config?: GatewayConfig) {
  const router = Router();

  router.get("/", async (_req, res, next) => {
    try {
      const users = await userService.listUsers();
      res.json({ data: users.map(sanitizeUser) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:id", async (req, res, next) => {
    try {
      const user = await userService.getUserById(req.params.id);
      if (!user) {
        res.status(404).json({ success: false, error: "User not found" });
        return;
      }
      res.json({ data: sanitizeUser(user) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const email = normalizeEmail(req.body.email || "");
      const { name, password, is_admin } = req.body;
      if (!email || !name || !password) {
        res.status(400).json({ success: false, error: "Email, name, and password are required" });
        return;
      }

      if (!EMAIL_REGEX.test(email)) {
        res.status(400).json({ success: false, error: "Invalid email format" });
        return;
      }

      const passwordError = validatePassword(password);
      if (passwordError) {
        res.status(400).json({ success: false, error: passwordError });
        return;
      }

      const existing = await userService.getUserByEmail(email);
      if (existing) {
        res.status(409).json({ success: false, error: "User with this email already exists" });
        return;
      }

      if (!config?.publicAppUrl || !config.authEncryptionKey) {
        throw new Error("Authentication email configuration is required to create users");
      }
      const user = await registerUser({
        email,
        name,
        password,
        isAdmin: is_admin === true,
        encryptionKey: config.authEncryptionKey,
        baseUrl: config.publicAppUrl,
      });
      if (!user) {
        res.status(409).json({ success: false, error: "User with this email already exists" });
        return;
      }
      res.status(201).json({ data: sanitizeUser(user) });
    } catch (error) {
      next(error);
    }
  });

  const VALID_STATUSES = ["active", "suspended", "blocked"];

  router.patch("/:id", async (req, res, next) => {
    try {
      const updates: { name?: string; email?: string; password_hash?: string; is_admin?: boolean; status?: string; suspended_until?: string | null } = {};
      const adminUser = req.user as User | undefined;

      // Prevent self-destructive role/status changes.
      if (adminUser?.id === req.params.id) {
        if (req.body.is_admin === false) {
          res.status(400).json({ success: false, error: "Cannot revoke your own admin rights" });
          return;
        }
        if (req.body.status === "blocked" || req.body.status === "suspended") {
          res.status(400).json({ success: false, error: "Cannot block or suspend yourself" });
          return;
        }
        if (req.body.email !== undefined || req.body.password !== undefined) {
          res.status(400).json({ success: false, error: "Use the authenticated account security endpoint" });
          return;
        }
        if (req.body.suspended_until) {
          const date = new Date(req.body.suspended_until);
          if (!Number.isNaN(date.getTime()) && date.getTime() > Date.now()) {
            res.status(400).json({ success: false, error: "Cannot suspend yourself" });
            return;
          }
        }
      }

      if (req.body.name !== undefined) updates.name = req.body.name;
      if (req.body.email !== undefined) {
        const normalized = normalizeEmail(req.body.email);
        if (!EMAIL_REGEX.test(normalized)) {
          res.status(400).json({ success: false, error: "Invalid email format" });
          return;
        }
        const existing = await userService.getUserByEmail(normalized);
        if (existing && existing.id !== req.params.id) {
          res.status(409).json({ success: false, error: "User with this email already exists" });
          return;
        }
        updates.email = normalized;
      }
      if (req.body.password !== undefined) {
        const passwordError = validatePassword(req.body.password);
        if (passwordError) {
          res.status(400).json({ success: false, error: passwordError });
          return;
        }
        updates.password_hash = await hashPassword(req.body.password);
      }
      if (req.body.is_admin !== undefined) {
        if (typeof req.body.is_admin !== "boolean") {
          res.status(400).json({ success: false, error: "is_admin must be a boolean" });
          return;
        }
        updates.is_admin = req.body.is_admin;
      }
      if (req.body.status !== undefined) {
        if (!VALID_STATUSES.includes(req.body.status)) {
          res.status(400).json({ success: false, error: `Status must be one of: ${VALID_STATUSES.join(", ")}` });
          return;
        }
        updates.status = req.body.status;
      }
      if (req.body.suspended_until !== undefined) {
        if (req.body.suspended_until === null) {
          updates.suspended_until = null;
        } else {
          const date = new Date(req.body.suspended_until);
          if (Number.isNaN(date.getTime())) {
            res.status(400).json({ success: false, error: "suspended_until must be a valid date" });
            return;
          }
          updates.suspended_until = req.body.suspended_until;
        }
      }

      const user = await userService.updateUser(req.params.id, updates);
      if (!user) {
        res.status(404).json({ success: false, error: "User not found" });
        return;
      }
      res.json({ data: sanitizeUser(user) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:id/suspend", async (req, res, next) => {
    try {
      const { duration, unit } = req.body;
      if (typeof duration !== "number" || duration <= 0) {
        res.status(400).json({ success: false, error: "Duration must be a positive number" });
        return;
      }
      const validUnits = ["hours", "days", "weeks"] as const;
      if (!validUnits.includes(unit)) {
        res.status(400).json({ success: false, error: "Unit must be: hours, days, or weeks" });
        return;
      }

      const adminUser = req.user as User | undefined;
      if (adminUser?.id === req.params.id) {
        res.status(400).json({ success: false, error: "Cannot suspend yourself" });
        return;
      }

      const msPerUnit: Record<typeof validUnits[number], number> = { hours: 60 * 60 * 1000, days: 24 * 60 * 60 * 1000, weeks: 7 * 24 * 60 * 60 * 1000 };
      const durationMs = duration * msPerUnit[unit as typeof validUnits[number]];

      const user = await userService.suspendUser(req.params.id, durationMs);
      if (!user) {
        res.status(404).json({ success: false, error: "User not found" });
        return;
      }
      res.json({ data: sanitizeUser(user) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:id/block", async (req, res, next) => {
    try {
      const adminUser = req.user as User | undefined;
      if (adminUser?.id === req.params.id) {
        res.status(400).json({ success: false, error: "Cannot block yourself" });
        return;
      }

      const user = await userService.blockUser(req.params.id);
      if (!user) {
        res.status(404).json({ success: false, error: "User not found" });
        return;
      }
      res.json({ data: sanitizeUser(user) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:id/activate", async (req, res, next) => {
    try {
      const user = await userService.activateUser(req.params.id);
      if (!user) {
        res.status(404).json({ success: false, error: "User not found" });
        return;
      }
      res.json({ data: sanitizeUser(user) });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/:id", async (req, res, next) => {
    try {
      const adminUser = req.user as User | undefined;
      if (adminUser?.id === req.params.id) {
        res.status(400).json({ success: false, error: "Cannot delete yourself" });
        return;
      }

      const result = await userService.deleteUserSafely(req.params.id);
      if (result === "not_found") {
        res.status(404).json({ success: false, error: "User not found" });
        return;
      }
      if (result === "last_admin") {
        res.status(400).json({ success: false, error: "Cannot delete the last admin user" });
        return;
      }
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function sanitizeUser(user: User) {
  return serializeUser(user);
}
