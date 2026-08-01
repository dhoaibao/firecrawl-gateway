import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import bcrypt from "bcrypt";
import * as userService from "../users/service";
import { needsRehash } from "./password";
import type { User } from "../types";

passport.use(
  new LocalStrategy(
    { usernameField: "email", passwordField: "password" },
    async (email, password, done) => {
      try {
        const user = await userService.getUserByEmail(email);
        const valid = user
          ? await bcrypt.compare(password, user.password_hash)
          : await bcrypt.compare(password, "$2b$12$LQv3c1yqBWxqk5f7VfYJ6eQZ2q9mT4r7e3W8mM5vG2cR9aK6nPq1S");
        if (!user || !valid || !user.email_verified_at) {
          return done(null, false, { message: "Invalid email or password" });
        }

        const access = userService.checkUserAccess(user);
        if (!access.allowed) {
          return done(null, false, { message: "Invalid email or password" });
        }

        if (needsRehash(user.password_hash)) {
          const replacement = await bcrypt.hash(password, Number(process.env.BCRYPT_ROUNDS || 12));
          const updatedUser = await userService.updateUser(user.id, { password_hash: replacement });
          if (!updatedUser) return done(null, false, { message: "Invalid email or password" });
          return done(null, updatedUser);
        }
        return done(null, user);
      } catch (error) {
        return done(error);
      }
    },
  ),
);

passport.serializeUser((user, done) => {
  done(null, (user as User).id);
});

passport.deserializeUser(async (id: string, done) => {
  try {
    const user = await userService.getUserById(id);
    if (!user) {
      return done(null, false);
    }
    done(null, user);
  } catch (error) {
    done(error);
  }
});

export { passport };
