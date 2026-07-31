import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import bcrypt from "bcrypt";
import * as userService from "../users/service";
import type { User } from "../types";

passport.use(
  new LocalStrategy(
    { usernameField: "email", passwordField: "password" },
    async (email, password, done) => {
      try {
        const user = await userService.getUserByEmail(email);
        if (!user) {
          return done(null, false, { message: "Invalid email or password" });
        }

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
          return done(null, false, { message: "Invalid email or password" });
        }

        const access = userService.checkUserAccess(user);
        if (!access.allowed) {
          return done(null, false, { message: access.reason });
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
