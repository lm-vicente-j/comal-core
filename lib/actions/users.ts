"use server";
import prisma from "../prisma";
import type { Prisma } from "@/app/generated/prisma/client";
import { User } from "./schemas";
import bcrypt from 'bcryptjs';
import { revalidatePath } from "next/cache";
import { UserSchema } from "./schemas";
import { auth } from "../auth";
import z from "zod";
import { AdminListQuerySchema, escapeListSearch } from "@/components/pagination/schema";

function randomDigits(digits: number): string {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  const mod = 10 ** digits;
  return String(arr[0] % mod).padStart(digits, "0");
}

function GenerateUsername({ fullname, extraDigits = 2 }: { fullname: string; extraDigits?: number }) {
  const normalized = fullname.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const splitted = normalized.trim().toUpperCase().split(/\s+/).filter(Boolean);
  if (splitted.length < 2) return "";

  const firstLastName = splitted[splitted.length - 2];
  const secondLastName = splitted[splitted.length - 1];
  const firstVowels = firstLastName.match(/[AEIOU]/gi);

  let prefix = firstLastName[0] || "U";
  if (firstVowels) {
    prefix += firstVowels[0];
    prefix += secondLastName[0] || firstLastName[0];
    prefix += splitted[0][0];
  } else {
    prefix += secondLastName[0] || "X";
  }

  return `${prefix.replaceAll("@", "") || "U"}${randomDigits(extraDigits)}`;
}

async function generateUniqueUsername(fullname: string, db: Prisma.TransactionClient = prisma): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = GenerateUsername({
      fullname,
      extraDigits: attempt < 10 ? 2 : 4,
    });
    if (!candidate) return "";
    const exists = await db.users.findFirst({
      where: { username: { equals: candidate, mode: "insensitive" } },
      select: { id: true },
    });
    if (!exists) return candidate;
  }
  return `${GenerateUsername({ fullname, extraDigits: 4 })}${randomDigits(2)}`;
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

export async function getStaffPage(query: unknown = {}) {
  const session = await auth();
  const input = AdminListQuerySchema.safeParse(query);
  if (session?.user?.role !== "ADMIN" || !input.success) return { rows: [], total: 0, page: 1 };

  const { pageSize, search, sort, desc } = input.data;
  const field = sort === "username" || sort === "role" || sort === "active" ? sort : "name";
  const direction = desc ? "desc" : "asc";
  const where = search ? { name: { contains: escapeListSearch(search), mode: "insensitive" as const } } : undefined;
  const total = await prisma.users.count({ where });
  const page = Math.min(input.data.page, Math.max(1, Math.ceil(total / pageSize)));
  const rows = await prisma.users.findMany({
    select: { id: true, name: true, email: true, username: true, active: true, role: true, password: true, pin: true },
    where,
    orderBy: [{ [field]: { sort: direction, nulls: "last" } }, { id: direction }],
    take: pageSize,
    skip: (page - 1) * pageSize,
  });
  return {
    rows: rows.map(({ password, pin, ...user }) => ({ ...user, hasPassword: !!password, hasPin: !!pin })),
    total,
    page,
  };
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

export async function saveUser(data: Partial<User>): Promise<{
  success: boolean;
  error?: string;
  fieldErrors?: Partial<Record<keyof User, string[]>>;
}> {

  const session = await auth();
  if (session?.user?.role !== "ADMIN") {
    return { success: false, error: "UNAUTHORIZED" };
  }

  const isUpdate = data?.id !== undefined && data?.id !== null;
  const normalizedData = {
    ...data,
    ...(typeof data?.email === "string" ? { email: data.email.trim().toLowerCase() } : {}),
  };
  let parsedData: Partial<User>;
  if (isUpdate) {
    const parsed = UserSchema.pick({ id: true, password: true, name: true, role: true, pin: true, email: true, active: true })
      .partial({ email: true, active: true, pin: true, password: true, role: true, name: true })
      .safeParse(normalizedData);
    if (!parsed.success) {
      return { success: false, error: "Datos inválidos", fieldErrors: z.flattenError(parsed.error).fieldErrors };
    }
    parsedData = parsed.data;
  } else {
    const parsed = UserSchema.pick({ name: true, role: true, password: true, pin: true, email: true, active: true })
      .partial({ email: true, active: true, pin: true, password: true })
      .safeParse(normalizedData);
    if (!parsed.success) {
      const fieldErrors = { ...z.flattenError(parsed.error).fieldErrors };
      if (data?.role === "STAFF") {
        if (typeof data.pin !== "string" || !/^\d{4}$/.test(data.pin)) {
          fieldErrors.pin = fieldErrors.pin ?? ["El PIN debe tener 4 dígitos"];
        }
      } else if (data?.role === "ADMIN") {
        if (typeof data.password !== "string" || data.password.trim().length < 4) {
          fieldErrors.password = fieldErrors.password ?? ["Mínimo 4 caracteres"];
        }
      }
      return { success: false, error: "Datos inválidos", fieldErrors };
    }
    parsedData = parsed.data;
  }

  try {
    const { id, name, role, active, password, email, pin } = parsedData;

    if (isUpdate) {
      const change = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT id FROM users WHERE id = ${id} FOR UPDATE`;
        const existing = await tx.users.findUnique({
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
          if (trimmedEmail) {
            const dupEmail = await tx.users.findFirst({
              where: { email: { equals: trimmedEmail, mode: "insensitive" }, id: { not: id! } },
              select: { id: true },
            });
            if (dupEmail) {
              return {
                success: false,
                error: "Datos inválidos",
                fieldErrors: { email: ["Este correo electrónico ya está registrado"] },
              };
            }
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
            const staffUsername = (await generateUniqueUsername(existing.name || name || "staff user", tx)) || `staff${existing.id}`;
            updateData.username = staffUsername;
          }
        }

        // On STAFF-to-ADMIN promotion, ensure a usable email is saved so login is preserved
        if (targetRole === "ADMIN") {
          const usableEmail = (email !== undefined && email !== null && email.trim() !== "")
            ? email.trim()
            : existing.email;
          if (!usableEmail || !z.email().safeParse(usableEmail).success) {
            return {
              success: false,
              error: "Datos inválidos",
              fieldErrors: { email: ["El correo electrónico es requerido para administradores"] },
            };
          }
          updateData.email = usableEmail;
        }

        await tx.users.update({
          where: { id: id! },
          data: updateData,
        });
        return { success: true };
      });
      if (!change.success) return change;

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

      const username = await generateUniqueUsername(name.trim());

      if (!username) {
        return { success: false, error: "No se pudo generar un nombre de usuario con el nombre proporcionado." };
      }

      const trimmedEmail = email?.trim() ? email.trim() : null;
      if (trimmedEmail) {
        const dupEmail = await prisma.users.findFirst({
          where: { email: { equals: trimmedEmail, mode: "insensitive" } },
          select: { id: true },
        });
        if (dupEmail) {
          return {
            success: false,
            error: "Datos inválidos",
            fieldErrors: { email: ["Este correo electrónico ya está registrado"] },
          };
        }
      }

      if (role === "STAFF") {
        await prisma.users.create({
          data: {
            name: name.trim(),
            role,
            active: active ?? true,
            pin: hashedPass,
            username,
            email: trimmedEmail,
          },
        });
      } else {
        // Admins log in with email + password, so a valid email is strictly required.
        const adminEmail = trimmedEmail;
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
