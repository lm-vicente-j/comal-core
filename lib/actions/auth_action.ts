"use server";

import { AuthError } from "next-auth";
import { z } from "zod";
import { signIn, signOut } from "../auth";
import { isAccountLockedOut } from "../auth-credentials";
import { actionFail, type ActionFailure } from "../action-result";

export async function login(_prevState: unknown, formData: FormData): Promise<ActionFailure | undefined> {
  if (!formData || typeof formData.get !== "function") return actionFail("Invalid form data");

  const email = formData.get("email");
  const password = formData.get("password");
  const requestedMode = formData.get("authMode");
  const isOwnerLogin = typeof email === "string" && email.trim().length > 0;
  const authMode = isOwnerLogin
    ? "OWNER_PASSWORD"
    : requestedMode === "MOBILE_PIN" ? "MOBILE_PIN" : requestedMode === "FIXED_PIN" ? "FIXED_PIN" : null;
  const username = formData.get("username");
  const pin = formData.get("pin");

  const fieldErrors: Record<string, string[]> = {};
  if (isOwnerLogin) {
    if (!z.email().max(150).safeParse(typeof email === "string" ? email.trim() : email).success) {
      fieldErrors.email = ["Enter a valid email address"];
    }
    if (typeof password !== "string" || password.length === 0) fieldErrors.password = ["Password is required"];
    else if (new TextEncoder().encode(password).byteLength > 72) fieldErrors.password = ["Password must be at most 72 bytes"];
  } else {
    if (!authMode) fieldErrors.authMode = ["Choose a valid sign-in mode"];
    if (typeof pin !== "string" || !/^\d{6}$/.test(pin)) fieldErrors.pin = ["PIN must contain six digits"];
    if (authMode === "MOBILE_PIN" && (typeof username !== "string" || !username.trim())) {
      fieldErrors.username = ["Username is required"];
    }
  }
  if (Object.keys(fieldErrors).length) return actionFail("Invalid credentials", { fieldErrors });

  const identifier = isOwnerLogin ? String(email).trim() : authMode === "MOBILE_PIN" ? String(username).trim() : "";
  try {
    await signIn("credentials", {
      authMode,
      email: isOwnerLogin ? String(email).trim() : undefined,
      password: isOwnerLogin ? password : undefined,
      username: authMode === "MOBILE_PIN" ? String(username).trim() : undefined,
      pin: !isOwnerLogin ? pin : undefined,
      redirectTo: "/pos",
    });
  } catch (error) {
    if (error instanceof AuthError) {
      if (error.type === "CredentialsSignin" && await isAccountLockedOut(identifier, isOwnerLogin ? "ADMIN" : "STAFF").catch(() => false)) {
        return actionFail("Too many failed attempts. Try again later.");
      }
      if (error.type === "CredentialsSignin") return actionFail("Incorrect credentials or unauthorized terminal.");
      return actionFail("Authentication service error.");
    }
    throw error;
  }
}

export async function logout(): Promise<void> {
  await signOut({ redirectTo: "/login" });
}
