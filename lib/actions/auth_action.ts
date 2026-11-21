'use server'

import { signIn } from "../auth"
import { signOut } from "../auth"
import { AuthError } from "next-auth"
import { UserSchema } from "./schemas"
import { isAccountLockedOut } from "../auth-credentials"
import z from "zod"

export async function login(prevState: any, formData: FormData) {
  if (!formData || typeof (formData as FormData).get !== "function") {
    return {
      success: false,
      error: "Datos inválidos",
    };
  }

  const rawEmail = formData.get("email");
  const isAdminLogin = typeof rawEmail === "string" && rawEmail.trim().length > 0;
  const raw = isAdminLogin
    ? {
        email: rawEmail,
        name: null,
        username: null,
        pin: null,
        password: formData.get("password"),
      }
    : {
        email: null,
        name: null,
        username: formData.get("username"),
        pin: formData.get("pin"),
        password: null,
      };
  const parsed = UserSchema.omit({registeredAt: true, role: true, active: true, name: true}).safeParse(raw);
  const schemaFieldErrors: Record<string, string[] | undefined> = parsed.success
    ? {}
    : z.flattenError(parsed.error).fieldErrors;

  const email = typeof raw.email === "string" ? raw.email.trim() : "";
  const username = typeof raw.username === "string" ? raw.username.trim() : "";
  const pin = typeof raw.pin === "string" ? raw.pin : "";
  const password = typeof raw.password === "string" ? raw.password : "";

  const role = isAdminLogin ? "ADMIN" : "STAFF";
  const fieldErrors: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(schemaFieldErrors)) {
    if (v && v.length > 0) fieldErrors[k] = v;
  }

  if (role === "ADMIN") {
    if (!password || password.trim().length < 4) {
      fieldErrors.password = fieldErrors.password ?? ["Mínimo 4 caracteres"];
    }
  } else {
    if (!username) {
      fieldErrors.username = fieldErrors.username ?? ["El nombre de usuario es requerido"];
    }
    if (!pin || !/^\d{4}$/.test(pin)) {
      fieldErrors.pin = fieldErrors.pin ?? ["El PIN debe tener 4 dígitos"];
    }
  }

  if (!parsed.success || Object.keys(fieldErrors).length > 0) {
    return {
      success: false,
      error: "Datos inválidos",
      fieldErrors,
    };
  }

  const identifier = role === "ADMIN" ? email : username;

  try {
    await signIn("credentials", {
      email,
      password,
      username: username,
      pin,
      role,
      redirectTo: "/pos",
    });
  } catch (e) {
    if (e instanceof AuthError) {
      if (e.type === "CredentialsSignin" && await isAccountLockedOut(identifier, role).catch(() => false)) {
        return { error: "Demasiados intentos fallidos. Cuenta bloqueada temporalmente." };
      }
      switch (e.type) {
        case "CredentialsSignin":
          return { error: "Usuario o contraseña incorrectos." };
        default:
          return { error: "SERVER ERROR, CONTACT SUPPORT." };
      }
    }

    throw e;
  }

}

export async function logout() {

  try {
    await signOut({ redirectTo: "/login" });
  } catch (e) {
    throw e
  }

}
