import { Router } from "express";
import bcrypt from "bcrypt";
import { passport } from "./passport";
import * as userService from "../users/service";
import { requireAuth } from "./middleware";
import type { AuthenticatedRequest } from "./middleware";
import type { User } from "../types";
import { serializeUser } from "../users/serialization";
import { authenticatedUserSchema } from "@firecrawl/contracts";

export function createAuthRouter() {
  const router = Router();

  router.post("/login", (req, res, next) => {
    passport.authenticate("local", (err: Error | null, user: Express.User | false, info: { message?: string }) => {
      if (err) {
        return next(err);
      }
      if (!user) {
        return res.status(401).json({ success: false, error: info?.message || "Invalid credentials" });
      }
      req.session.regenerate((err) => {
        if (err) {
          return next(err);
        }
        req.logIn(user, (err) => {
          if (err) {
            return next(err);
          }
          req.session.save((err) => {
            if (err) {
              return next(err);
            }
            res.json({ success: true, data: authenticatedUserSchema.parse(serializeUser(user as User)) });
          });
        });
      });
    })(req, res, next);
  });

  router.post("/logout", (req, res, next) => {
    req.logout((err) => {
      if (err) {
        return next(err);
      }
      req.session.destroy((err) => {
        if (err) {
          return next(err);
        }
        res.clearCookie("firecrawl.sid");
        res.json({ success: true });
      });
    });
  });

  router.get("/me", requireAuth, (req: AuthenticatedRequest, res) => {
    res.json({ data: authenticatedUserSchema.parse(serializeUser(req.user as User)) });
  });

  router.post("/password", requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      const { current_password, new_password } = req.body;
      if (typeof current_password !== "string" || typeof new_password !== "string") {
        res.status(400).json({ success: false, error: "Current password and new password are required" });
        return;
      }
      if (new_password.length < 8) {
        res.status(400).json({ success: false, error: "Password must be at least 8 characters" });
        return;
      }
      if (new_password.length > 128) {
        res.status(400).json({ success: false, error: "Password must be at most 128 characters" });
        return;
      }

      const user = req.user;
      if (!user || !(await bcrypt.compare(current_password, user.password_hash))) {
        res.status(401).json({ success: false, error: "Current password is incorrect" });
        return;
      }

      const passwordHash = await bcrypt.hash(new_password, Number(process.env.BCRYPT_ROUNDS || 12));
      await userService.updateUser(user.id, { password_hash: passwordHash });
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
