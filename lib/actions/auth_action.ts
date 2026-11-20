'use server'

import { signIn } from "../auth"
import { signOut } from "../auth"
import { AuthError } from "next-auth"
import { UserSchema } from "./schemas"
import { isLockedOut } from "../auth-lockout"
import z from "zod"

export async function login(prevState: any, formData: FormData) {
  
  const raw = {
    email: formData.get("email"),
    name: formData.get("name"),
    username: formData.get("username"),
    pin: formData.get("pin"),
    password: formData.get("password"),
  };
  
  const parsed = UserSchema.omit({registeredAt: true, role: true, active: true, name: true}).safeParse(raw);
  if (!parsed.success) {
    return {
      success: false,
      error: "Datos inválidos",
      fieldErrors: z.flattenError(parsed.error).fieldErrors
    };
  }

  const email = parsed.data.email;
  const username = parsed.data.username;

  const pin = parsed.data.pin;
  const password = parsed.data.password;

  const role = email ? "ADMIN" : "STAFF";
  const identifier = role === "ADMIN" ? email : username;

  if (identifier && isLockedOut(identifier)) {
    return { error: "Demasiados intentos fallidos. Cuenta bloqueada temporalmente." };
  }

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
      if (identifier && isLockedOut(identifier)) {
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
