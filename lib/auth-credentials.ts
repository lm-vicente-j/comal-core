// lib/auth-credentials.ts
import { z } from "zod";
import bcrypt from "bcryptjs";
import prisma from "./prisma";
import { normalizeUserRole } from "@/lib/auth-types";
import {
  isLockedOut,
  recordFailedAttempt,
  clearFailedAttempts,
} from "./auth-lockout";

export const credentialsSchema = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("ADMIN"),
    email: z.string().trim().email(),
    password: z.string().min(1),
  }),
  z.object({
    role: z.literal("STAFF"),
    username: z.string().trim().min(1),
    pin: z.string().regex(/^\d{4}$/),
  }),
]);

export async function authorizeCredentials(credentials: Record<string, unknown>) {
  const parsedCredentials = credentialsSchema.safeParse(credentials);

  if (!parsedCredentials.success) return null;

  if (parsedCredentials.data.role === "ADMIN") {
    const email = parsedCredentials.data.email.trim().toLowerCase();
    if (isLockedOut(email)) return null;

    const user = await prisma.users.findFirst({
      where: { email: parsedCredentials.data.email },
    });

    if (!user?.password || user.active === false || normalizeUserRole(user.role) !== "ADMIN") {
      recordFailedAttempt(email);
      return null;
    }

    const isPasswordCorrect = await bcrypt.compare(
      parsedCredentials.data.password,
      user.password,
    );

    if (!isPasswordCorrect) {
      recordFailedAttempt(email);
      return null;
    }

    clearFailedAttempts(email);

    return {
      id: user.id.toString(),
      name: user.name,
      email: user.email,
      role: "ADMIN" as const,
    };
  }

  // STAFF login
  const username = parsedCredentials.data.username.trim().toLowerCase();
  if (isLockedOut(username)) return null;

  const user = await prisma.users.findFirst({
    where: { username: parsedCredentials.data.username },
  });

  // Enforce role: Only users whose stored role normalizes to STAFF can log in via PIN
  if (!user?.pin || user.active === false || normalizeUserRole(user.role) !== "STAFF") {
    recordFailedAttempt(username);
    return null;
  }

  const isPinCorrect = await bcrypt.compare(
    parsedCredentials.data.pin,
    user.pin,
  );

  if (!isPinCorrect) {
    recordFailedAttempt(username);
    return null;
  }

  clearFailedAttempts(username);

  return {
    id: user.id.toString(),
    name: user.name,
    email: undefined,
    role: "STAFF" as const,
  };
}
