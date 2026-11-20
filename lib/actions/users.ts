"use server";
import prisma from "../prisma";
import { User } from "./schemas";
import bcrypt from 'bcryptjs';
import { revalidatePath } from "next/cache";
import { UserSchema } from "./schemas";
import { auth } from "../auth";
import z from "zod";

function GenerateUsername({ fullname }: { fullname: string }) {
  let username = "";
  const normalized = fullname.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const splitted = normalized.trim().toUpperCase().split(/\s+/).filter(Boolean);
  if (splitted.length < 2) return "";

  const firstLastName = splitted[splitted.length - 2];
  const secondLastName = splitted[splitted.length - 1];
  const firstVowels = firstLastName.match(/[AEIOU]/gi);

  username = firstLastName[0] || "U";

  if (firstVowels) {
    username += firstVowels[0];
    username += secondLastName[0] || firstLastName[0];
    username += splitted[0][0];

    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    username += arr[0].toString()[0];
    username += arr[0].toString()[1];

    return username;
  } else {
    return `${username}${secondLastName[0] || "X"}01`;
  }
}

export async function GetAllUsers() {
  const session = await auth();
  if (session?.user?.role !== "ADMIN") return [];

  try {
    const userList = await prisma.users.findMany({
      select: { id: true, name: true, email: true, username: true, active: true, role: true, password: true, pin: true },
      orderBy: { name: 'asc' },
    });
    // Expose only whether a credential exists; hashes never leave the server.
    return userList.map(({ password, pin, ...user }) => ({
      ...user,
      hasPassword: !!password,
      hasPin: !!pin,
    }));
  } catch (e) {
    console.error(e);
    return [];
  }
}

export async function searchUsers(query: string, limit = 20) {
  const session = await auth();
  if (session?.user?.role !== "ADMIN") return [];

  if (typeof query !== "string") return [];

  const safeLimit = Math.min(100, Math.max(1, Number.isInteger(limit) ? limit : 20));
  const trimmed = query.trim();

  try {
    return await prisma.users.findMany({
      where: trimmed
        ? {
            OR: [
              { name: { contains: trimmed, mode: "insensitive" } },
              { username: { contains: trimmed, mode: "insensitive" } },
            ],
          }
        : undefined,
      select: { id: true, name: true, username: true, registeredAt: true },
      orderBy: { name: 'asc' },
      take: safeLimit,
    });
  } catch (e) {
    console.error(e);
    return [];
  }
}

export async function saveUser(data: Partial<User>) {

  const session = await auth();
  if (session?.user?.role !== "ADMIN") {
    return { success: false, error: "UNAUTHORIZED" };
  }

  const isUpdate = data.id !== undefined && data.id !== null;
  if (isUpdate) {
    const parsed = UserSchema.pick({ id: true, password: true, name: true, role: true, pin: true, email: true, active: true })
      .partial({ email: true, active: true, pin: true, password: true, role: true, name: true })
      .safeParse(data);
    if (!parsed.success) {
      return { success: false, error: "Datos inválidos", fieldErrors: z.flattenError(parsed.error).fieldErrors };
    }
  } else {
    const parsed = UserSchema.pick({ name: true, role: true, password: true, pin: true, email: true, active: true })
      .partial({ email: true, active: true, pin: true, password: true })
      .safeParse(data);
    if (!parsed.success) {
      return { success: false, error: "Datos inválidos", fieldErrors: z.flattenError(parsed.error).fieldErrors };
    }
  }

  try {
    const { id, name, role, active, password, email, pin } = data;

    if (isUpdate) {
      // UPDATE
      const existing = await prisma.users.findUnique({
        where: { id: id! },
        select: { id: true, name: true, role: true, email: true, username: true }
      });
      if (!existing) {
        return { success: false, error: "Usuario no encontrado" };
      }

      const targetRole = role ?? (existing.role as "ADMIN" | "STAFF");

      // Require a new valid credential when changing the role
      const isRoleChanging = role !== undefined && role !== existing.role;
      if (isRoleChanging) {
        if (targetRole === "STAFF") {
          if (!pin || !/^\d{4}$/.test(pin)) {
            return {
              success: false,
              error: "Datos inválidos",
              fieldErrors: { pin: ["El PIN debe tener 4 dígitos"] }
            };
          }
        } else if (targetRole === "ADMIN") {
          if (!password || password.trim().length < 4) {
            return {
              success: false,
              error: "Datos inválidos",
              fieldErrors: { password: ["Mínimo 4 caracteres"] }
            };
          }
        }
      }

      // Validate credential format if provided during update
      if (password !== undefined && password !== null && password !== "") {
        if (targetRole === "ADMIN" && password.trim().length < 4) {
          return {
            success: false,
            error: "Datos inválidos",
            fieldErrors: { password: ["Mínimo 4 caracteres"] }
          };
        }
      }
      if (pin !== undefined && pin !== null && pin !== "") {
        if (targetRole === "STAFF" && !/^\d{4}$/.test(pin)) {
          return {
            success: false,
            error: "Datos inválidos",
            fieldErrors: { pin: ["El PIN debe tener 4 dígitos"] }
          };
        }
      }

      const rawCredential = targetRole === "STAFF" ? pin : password;
      let hashedPass: string | null = null;

      if (rawCredential && rawCredential.trim() !== "") {
        hashedPass = await bcrypt.hash(rawCredential.trim(), 10);
      }

      const updateData: Record<string, any> = {
        ...(name !== undefined && { name: name.trim() }),
        ...(role !== undefined && { role }),
        ...(active !== undefined && { active }),
      };

      if (email !== undefined) {
        const trimmedEmail = email?.trim() ? email.trim() : null;
        if (targetRole === "ADMIN" && !trimmedEmail) {
          return {
            success: false,
            error: "Datos inválidos",
            fieldErrors: { email: ["El correo electrónico es requerido para administradores"] },
          };
        }
        updateData.email = trimmedEmail;
      }

      if (hashedPass) {
        if (targetRole === "STAFF") {
          updateData.pin = hashedPass;
          updateData.password = null;
        } else {
          updateData.password = hashedPass;
          updateData.pin = null;
        }
      }

      // If target is STAFF, ensure username exists so login is preserved
      if (targetRole === "STAFF") {
        if (!existing.username) {
          const staffUsername = GenerateUsername({ fullname: existing.name || name || "staff" }) || `staff${existing.id}`;
          updateData.username = staffUsername;
        }
      }

      // On STAFF-to-ADMIN promotion, ensure a usable email is saved so login is preserved
      if (targetRole === "ADMIN") {
        const usableEmail = (email !== undefined && email !== null && email.trim() !== "")
          ? email.trim()
          : existing.email;
        if (!usableEmail) {
          return {
            success: false,
            error: "Datos inválidos",
            fieldErrors: { email: ["El correo electrónico es requerido para administradores"] },
          };
        }
        updateData.email = usableEmail;
      }

      await prisma.users.update({
        where: { id: id! },
        data: updateData,
      });

    } else {
      // CREATE
      if (!name || name.trim().split(/\s+/).filter(Boolean).length < 2) {
        return {
          success: false,
          error: "Datos inválidos",
          fieldErrors: { name: ["Debe ingresar nombre y apellido(s)"] },
        };
      }

      if (role === "STAFF") {
        if (!pin || !/^\d{4}$/.test(pin)) {
          return {
            success: false,
            error: "Datos inválidos",
            fieldErrors: { pin: ["El PIN debe tener 4 dígitos"] }
          };
        }
      } else {
        if (!password || password.trim().length < 4) {
          return {
            success: false,
            error: "Datos inválidos",
            fieldErrors: { password: ["Mínimo 4 caracteres"] }
          };
        }
      }

      const rawCredential = role === "STAFF" ? pin : password;
      const hashedPass = await bcrypt.hash(rawCredential!.trim(), 10);

      const username = GenerateUsername({ fullname: name.trim() });

      if (!username) {
        return { success: false, error: "No se pudo generar un nombre de usuario con el nombre proporcionado." };
      }

      if (role === "STAFF") {
        await prisma.users.create({
          data: {
            name: name.trim(),
            role,
            active: active ?? true,
            pin: hashedPass,
            username,
            email: email?.trim() ? email.trim() : null,
          },
        });
      } else {
        // Admins log in with email + password, so a valid email is strictly required.
        const adminEmail = email?.trim();
        if (!adminEmail) {
          return {
            success: false,
            error: "Datos inválidos",
            fieldErrors: { email: ["El correo electrónico es requerido para administradores"] },
          };
        }

        await prisma.users.create({
          data: {
            name: name.trim(),
            role: role || "ADMIN",
            active: active ?? true,
            password: hashedPass,
            username,
            email: adminEmail,
          },
        });
      }
    }

    revalidatePath("/admin/crm");
    return { success: true };

  } catch (e) {
    console.error(e);
    return { success: false, error: "Error al guardar el usuario." };
  }
}