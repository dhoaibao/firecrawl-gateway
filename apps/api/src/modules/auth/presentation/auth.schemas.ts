import { z } from "zod";

const optionalMfa = {
  mfa_code: z.string().trim().optional(),
  recovery_code: z.string().trim().optional(),
};

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export const loginMfaSchema = z.object({
  code: z.string().trim().optional(),
  recovery_code: z.string().trim().optional(),
}).refine((value) => Boolean(value.code || value.recovery_code), "An authentication code is required");

export const registerSchema = z.object({
  email: z.string().email(),
  name: z.string().trim().min(1),
  password: z.string(),
});

export const emailSchema = z.object({ email: z.string().email() });
export const tokenSchema = z.object({ token: z.string().min(1) });

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  new_password: z.string(),
});

export const changeEmailSchema = z.object({
  email: z.string().email(),
  current_password: z.string(),
  ...optionalMfa,
});

export const changePasswordSchema = z.object({
  current_password: z.string(),
  new_password: z.string(),
  mfa_code: z.string().trim().optional(),
});

export const reauthenticateSchema = z.object({
  current_password: z.string(),
  ...optionalMfa,
});

export const mfaCodeSchema = z.object({ code: z.string().trim().min(1) });
