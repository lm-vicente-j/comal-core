"use server";
import { z } from "zod";
import prisma from "../prisma";
import { revalidatePath } from "next/cache";
import { auth } from "../auth";
import { actionFail, actionOk, type ActionResult } from "../action-result";

// Keys of the business-wide settings kept on the server. Device-specific
// preferences (terminal label, etc.) are NOT here: they live in the browser's
// localStorage via lib/device-settings.ts. Kept local — a "use server" module
// can only export async functions (and types).
const SETTING_KEYS = {
  CLABE: "CLABE",
  CASH_COUNT_TOLERANCE_CENTS: "CASH_COUNT_TOLERANCE_CENTS",
} as const;

export type BusinessSettings = {
  clabe: string;
  cashCountToleranceCents: number;
};

const BusinessSettingsSchema = z
  .object({
    // A Mexican CLABE is exactly 18 digits. Empty is allowed so the account
    // can be cleared.
    clabe: z
      .string()
      .trim()
      .refine((v) => v === "" || /^\d{18}$/.test(v), {
        message: "La CLABE debe tener 18 dígitos.",
      })
      .optional(),
    cashCountToleranceCents: z
      .number()
      .int()
      .safe()
      .min(0)
      .max(100_000_000_000_000)
      .optional(),
  })
  .strict();

export async function getSettings(): Promise<BusinessSettings> {
  const session = await auth();
  if (session?.user?.role !== "ADMIN")
    return { clabe: "", cashCountToleranceCents: 0 };

  try {
    const rows = await prisma.setting.findMany({
      where: { key: { in: Object.values(SETTING_KEYS) } },
    });
    const byKey = new Map(rows.map((r) => [r.key, r.value ?? ""]));
    const toleranceValue = byKey.get(SETTING_KEYS.CASH_COUNT_TOLERANCE_CENTS);
    const tolerance = toleranceValue === undefined ? 0 : Number(toleranceValue);
    return {
      clabe: byKey.get(SETTING_KEYS.CLABE) ?? "",
      cashCountToleranceCents:
        Number.isSafeInteger(tolerance) &&
        tolerance >= 0 &&
        tolerance <= 100_000_000_000_000
          ? tolerance
          : 0,
    };
  } catch (e) {
    console.error(e);
    return { clabe: "", cashCountToleranceCents: 0 };
  }
}

export async function saveSettings(
  data: Partial<BusinessSettings>,
): Promise<ActionResult> {
  const session = await auth();
  if (session?.user?.role !== "ADMIN") {
    return actionFail("PERMISSION DENIED");
  }

  const parsed = BusinessSettingsSchema.safeParse(data);
  if (!parsed.success) {
    return actionFail("Datos inválidos", {
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  try {
    // upsert keeps the table as an append-free key/value store: the same
    // call works whether the setting has been saved before or not.
    await prisma.$transaction(async (tx) => {
      if (parsed.data.clabe !== undefined)
        await tx.setting.upsert({
          where: { key: SETTING_KEYS.CLABE },
          update: { value: parsed.data.clabe },
          create: { key: SETTING_KEYS.CLABE, value: parsed.data.clabe },
        });
      if (parsed.data.cashCountToleranceCents !== undefined)
        await tx.setting.upsert({
          where: { key: SETTING_KEYS.CASH_COUNT_TOLERANCE_CENTS },
          update: { value: String(parsed.data.cashCountToleranceCents) },
          create: {
            key: SETTING_KEYS.CASH_COUNT_TOLERANCE_CENTS,
            value: String(parsed.data.cashCountToleranceCents),
          },
        });
    });

    revalidatePath("/admin/settings");
    return actionOk();
  } catch (e) {
    console.error(e);
    return actionFail("Error al guardar la configuración.");
  }
}
