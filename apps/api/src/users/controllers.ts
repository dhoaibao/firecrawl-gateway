import type { Request, Response } from "express";
import type { GatewayConfig, User } from "../types";
import * as userService from "./service";
import { serializeUser } from "./serialization";
import { registerUser } from "../auth/service";
import { hashPassword, validatePassword } from "../auth/password";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_STATUSES = ["active", "suspended", "blocked"];
const VALID_SUSPENSION_UNITS = ["hours", "days", "weeks"] as const;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function id(req: Request): string {
  return String(req.params.id);
}

function currentUser(req: Request): User | undefined {
  return req.user as User | undefined;
}

function sanitizeUser(user: User) {
  return serializeUser(user);
}

export function createUsersControllers(config?: GatewayConfig) {
  return {
    list: async (_req: Request, res: Response): Promise<void> => {
      const users = await userService.listUsers();
      res.json({ data: users.map(sanitizeUser) });
    },

    get: async (req: Request, res: Response): Promise<void> => {
      const user = await userService.getUserById(id(req));
      if (!user) {
        res.status(404).json({ success: false, error: "User not found" });
        return;
      }
      res.json({ data: sanitizeUser(user) });
    },

    create: async (req: Request, res: Response): Promise<void> => {
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
      if (await userService.getUserByEmail(email)) {
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
    },

    update: async (req: Request, res: Response): Promise<void> => {
      const userId = id(req);
      const updates: {
        name?: string;
        email?: string;
        password_hash?: string;
        is_admin?: boolean;
        status?: string;
        suspended_until?: string | null;
      } = {};
      const adminUser = currentUser(req);

      if (adminUser?.id === userId) {
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
        if (existing && existing.id !== userId) {
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
        if (req.body.suspended_until === null) updates.suspended_until = null;
        else {
          const date = new Date(req.body.suspended_until);
          if (Number.isNaN(date.getTime())) {
            res.status(400).json({ success: false, error: "suspended_until must be a valid date" });
            return;
          }
          updates.suspended_until = req.body.suspended_until;
        }
      }

      const user = await userService.updateUser(userId, updates);
      if (!user) {
        res.status(404).json({ success: false, error: "User not found" });
        return;
      }
      res.json({ data: sanitizeUser(user) });
    },

    suspend: async (req: Request, res: Response): Promise<void> => {
      const { duration, unit } = req.body;
      if (typeof duration !== "number" || duration <= 0) {
        res.status(400).json({ success: false, error: "Duration must be a positive number" });
        return;
      }
      if (!VALID_SUSPENSION_UNITS.includes(unit)) {
        res.status(400).json({ success: false, error: "Unit must be: hours, days, or weeks" });
        return;
      }
      if (currentUser(req)?.id === id(req)) {
        res.status(400).json({ success: false, error: "Cannot suspend yourself" });
        return;
      }
      const msPerUnit: Record<typeof VALID_SUSPENSION_UNITS[number], number> = {
        hours: 60 * 60 * 1000,
        days: 24 * 60 * 60 * 1000,
        weeks: 7 * 24 * 60 * 60 * 1000,
      };
      const typedUnit = unit as typeof VALID_SUSPENSION_UNITS[number];
      const user = await userService.suspendUser(id(req), duration * msPerUnit[typedUnit]);
      if (!user) {
        res.status(404).json({ success: false, error: "User not found" });
        return;
      }
      res.json({ data: sanitizeUser(user) });
    },

    block: async (req: Request, res: Response): Promise<void> => {
      if (currentUser(req)?.id === id(req)) {
        res.status(400).json({ success: false, error: "Cannot block yourself" });
        return;
      }
      const user = await userService.blockUser(id(req));
      if (!user) {
        res.status(404).json({ success: false, error: "User not found" });
        return;
      }
      res.json({ data: sanitizeUser(user) });
    },

    activate: async (req: Request, res: Response): Promise<void> => {
      const user = await userService.activateUser(id(req));
      if (!user) {
        res.status(404).json({ success: false, error: "User not found" });
        return;
      }
      res.json({ data: sanitizeUser(user) });
    },

    remove: async (req: Request, res: Response): Promise<void> => {
      const userId = id(req);
      if (currentUser(req)?.id === userId) {
        res.status(400).json({ success: false, error: "Cannot delete yourself" });
        return;
      }
      const result = await userService.deleteUserSafely(userId);
      if (result === "not_found") {
        res.status(404).json({ success: false, error: "User not found" });
        return;
      }
      if (result === "last_admin") {
        res.status(400).json({ success: false, error: "Cannot delete the last admin user" });
        return;
      }
      res.status(204).send();
    },
  };
}
