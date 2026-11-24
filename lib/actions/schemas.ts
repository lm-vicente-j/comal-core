import { z } from "zod";
import { Decimal } from "@prisma/client/runtime/client";
import { toBusinessCalendarDate } from "../analytics";
import { createPaginationSchema } from "@/lib/pagination";

const INT4_MAX = 2_147_483_647;
const MAX_MONETARY_AMOUNT = 100_000_000_000_000;
const MAX_MILLIUNITS = 1_000_000_000_000_000;

export const SaleStatusSchema = z.enum(["UNPAID", "PAID", "DEBT", "CANCELLED"]);
// No default on purpose: the user has to pick the method.
export const PaymentMethodSchema = z.enum(["TRANSFER", "CASH"], {
  message: "Selecciona el método de pago",
});

export const BillSchema = z.object({
  id: z.number().int().positive().max(INT4_MAX),
  description: z.string().trim().min(1, "La descripción es requerida"),
  amount: z.preprocess(
    (val) => (val instanceof Decimal ? Number(val) : val),
    z.number({ error: (issue) => issue.input === undefined ? "El monto es requerido" : "El monto es inválido" })
      .refine((val) => Number.isSafeInteger(val), { message: "El monto es inválido" })
      .refine((val) => val > 0, { message: "El monto debe ser mayor a cero" })
      .refine((val) => val <= MAX_MONETARY_AMOUNT, { message: "El monto es inválido" }),
  ),
  date: z
    .date({ message: "La fecha es requerida" })
    .refine((d) => {
      if (!Number.isFinite(d.getTime()) || d.getUTCFullYear() < 1900) return false;
      const cal = toBusinessCalendarDate(d);
      const y = cal.getUTCFullYear();
      return Number.isFinite(cal.getTime()) && y >= 1900 && y <= 9999;
    }, {
      message: "La fecha es inválida",
    }),
  registered_by: z.number().int().positive().max(INT4_MAX),
  category: z.string().trim().min(1, "La categoría es requerida").max(50, "La categoría no puede superar 50 caracteres").optional(),
  receiptUrl: z.string().min(1, "La URL del recibo es requerida").nullable(),
  payment_method: PaymentMethodSchema,
});

export const CustomerSchema = z.object({
  id: z.number().int().positive().max(INT4_MAX),
  customerName: z.string().trim().min(3, "El nombre debe contener al menos 3 carácteres.").max(100, "El nombre no puede superar 100 caracteres"),
  phone: z.string().trim().max(20, "El teléfono no puede superar 20 caracteres").optional().nullable(),
  alias: z.string().trim().max(30, "El alias no puede superar 30 caracteres").nullable().optional(),
  lastConsumption: z.date().nullable().or(z.string()).optional(),
  currentBalance: z.number({ message: "El balance actual es requerido" }).int().safe().optional(),
  registeredDate: z.date().nullable().or(z.string()).optional(),

  debtors: z.array(
    z.object({
      id: z.number().int(),
      saleID: z.number().int(),
      amount: z.number({ message: "El monto es requerido" }).int().safe().nonnegative("El monto no puede ser negativo"),
      status: z.string().min(1, "El estado es requerido"),
    })
  ).optional(),

  sales: z.array(
    z.object({
      id: z.number().int(),
      total: z.number({ message: "El total es requerido" }).int().safe(),
      status: z.string().min(1, "El estado es requerido"),
      source_type: z.string().min(1, "El tipo de fuente es requerido"),
      createdAt: z.date().nullable().or(z.string().min(1, "La fecha es requerida")),
    })
  ).optional(),
});


export const DebtorsSchema = z.object({
  id: z.number().int(),
  saleID: z.number().int(),
  customerID: z.number().int(),
  amount: z.number({ message: "El monto es requerido" }).int().safe().positive("El monto debe ser mayor a cero"),
  status: SaleStatusSchema,
  createdAt: z.date({ message: "La fecha de creación es requerida" }),
  createdJornadaId: z.number().int(),
  // The three collection fields are set together and stay null while the debt is open.
  paidAt: z.date().nullable(),
  paidJornadaId: z.number().int().nullable(),
  collectedBy: z.number().int().nullable(),
});

export const ProductSchema = z.object({
    id: z.number({ error: "El ID del producto es inválido" })
        .int("El ID del producto es inválido")
        .positive("El ID del producto es inválido")
        .max(INT4_MAX, "El ID del producto es inválido")
        .optional(),
    name: z.string().trim().min(3, "Minimo 3 carácteres.").max(40, "Máximo 40 caracteres."),
    price: z.number({ error: (issue) => issue.input === undefined ? "El precio es requerido" : "El precio es inválido" })
        .refine((val) => Number.isSafeInteger(val), { message: "El precio es inválido" })
        .positive("El precio debe ser mayor de cero.")
        .max(MAX_MONETARY_AMOUNT, "El precio es inválido"),
    recipes: z.array(z.object({
        supplyID: z.number({ error: (issue) => issue.input === undefined ? "El ID del insumo es requerido" : "El ID del insumo es inválido" })
            .int("El ID del insumo es inválido")
            .positive("El ID del insumo es inválido")
            .max(INT4_MAX, "El ID del insumo es inválido"),
        quantityUsed: z.number({ error: (issue) => issue.input === undefined ? "La cantidad usada es requerida" : "La cantidad usada es inválida" })
            .refine((val) => Number.isSafeInteger(val), { message: "La cantidad usada es inválida" })
            .positive("La cantidad usada debe ser mayor a cero")
            .max(MAX_MILLIUNITS, "La cantidad usada es inválida"),
    })).optional()
});

export const RecipesSchema = z.object({
  productID: z.number({ message: "El ID del producto es requerido" }).int().positive().max(INT4_MAX),
  supplyID: z.number({ message: "El ID del insumo es requerido" }).int().positive().max(INT4_MAX),
  quantityUsed: z.number({ message: "La cantidad usada es requerida" }).int().safe().nonnegative("La cantidad usada no puede ser negativa"),
});

export const SalarySchema = z.object({
  id: z.number().int().positive().max(INT4_MAX),
  userID: z.number({ message: "El ID del usuario es requerido" }).int().positive().max(INT4_MAX),
  amount: z.preprocess(
    (val) => {
      if (typeof val === "number") return val;
      if (typeof val === "string" && /^-?\d+$/.test(val.trim())) return Number(val.trim());
      return val;
    },
    z.number({ error: (issue) => issue.input === undefined ? "El monto es requerido" : "El monto es inválido" })
      .refine((val) => Number.isSafeInteger(val), { message: "El monto es inválido" })
      .positive("El monto debe ser mayor a cero")
      .max(MAX_MONETARY_AMOUNT, "El monto es inválido"),
  ),
  payDate: z.date({ message: "La fecha de pago es requerida" }),
  // Validate that the reason does not exceed 50 characters, accounting for the payment-type prefix.
  period: z.string().trim().min(1, "El período es requerido").refine((value) => {
    const match = value.match(/^(ADELANTO|BONO|SUELDO):\s*([\s\S]*)$/);
    if (match) {
      const reasonPart = match[2].trim();
      return reasonPart.length > 0 && Array.from(reasonPart).length <= 50 && Array.from(value).length <= 65;
    }
    return Array.from(value).length <= 50;
  }, { message: "El motivo o período no puede superar los 50 caracteres" }),
  payment_method: PaymentMethodSchema,
});

export const SaleItemsSchema = z.object({
  id: z.number().int().positive().max(INT4_MAX),
  saleID: z.number({ message: "El ID de la venta es requerido" }).int().positive().max(INT4_MAX),
  productID: z.number({ message: "El ID del producto es requerido" }).int().positive().max(INT4_MAX),
  quantity: z.number({ message: "La cantidad es requerida" }).int().positive("La cantidad debe ser mayor a cero").max(INT4_MAX, "La cantidad excede el límite permitido"),
  unitPrice: z.number({ message: "El precio unitario es requerido" }).int().safe().positive("El precio unitario debe ser mayor a cero"),
  subtotal: z.number({ message: "El subtotal es requerido" }).int().safe().nonnegative("El subtotal no puede ser negativo"),
});

export const SalesSchema = z.object({
  id: z.number().int().positive().max(INT4_MAX),
  total: z.number({ message: "El total es requerido" }).int().safe(),
  source_type: z.string().trim().min(1, "El tipo de fuente es requerido").max(30, "El tipo de fuente no puede superar 30 caracteres"),
  customerID: z.number({ message: "El ID del cliente es requerido" }).int().min(-1).max(INT4_MAX),
  placedBy: z.number({ message: "El campo 'placedBy' es requerido" }).int().positive().max(INT4_MAX),
  createdAt: z.date({ message: "La fecha de creación es requerida" }),
  status: SaleStatusSchema,
  // Null until the sale is PAID.
  payment_method: PaymentMethodSchema.nullable(),
});

export const SupplySchema = z.object({
  id: z.number({ error: "El ID del insumo es inválido" })
    .int("El ID del insumo es inválido")
    .positive("El ID del insumo es inválido")
    .max(INT4_MAX, "El ID del insumo es inválido")
    .optional(),
  name: z.string().trim().min(1, "El nombre es requerido").max(40, "El nombre no puede superar 40 caracteres"),
  measureUnit: z.string().trim().min(1, "La unidad es requerida").max(30, "La unidad no puede superar 30 caracteres"),
  currentStock: z.number({ error: (issue) => issue.input === undefined ? "El stock actual es requerido" : "El stock es inválido" })
    .refine((val) => Number.isSafeInteger(val), { message: "El stock es inválido" })
    .nonnegative("El stock no puede ser negativo")
    .max(MAX_MILLIUNITS, "El stock es inválido"),
  unitCost: z.number({ error: (issue) => issue.input === undefined ? "El costo unitario es requerido" : "El costo unitario es inválido" })
    .refine((val) => Number.isSafeInteger(val), { message: "El costo unitario es inválido" })
    .positive("El costo unitario debe ser mayor de cero.")
    .max(MAX_MONETARY_AMOUNT, "El costo unitario es inválido"),
  recipes: z.array(
    z.object({
      productID: z.number({ message: "El ID del producto es requerido" }).int(),
      supplyID: z.number({ message: "El ID del insumo es requerido" }).int(),
      quantityUsed: z.number({ message: "La cantidad usada es requerida" }).int().safe().nonnegative("La cantidad usada no puede ser negativa"),
    })
  ).optional(),
});

export const UserSchema = z.object({
  id: z.number().int().positive().max(INT4_MAX).optional(),
  email: z.string().trim().email("Formato de correo inválido").max(150, "Máximo 150 caracteres").nullable().or(z.literal("")),
  name: z.string().trim().min(3, "El nombre es requerido").max(50, "Máximo 50 caracteres").refine((val) => val.trim().split(/\s+/).filter(Boolean).length >= 2, { message: "Debe ingresar nombre y apellido(s)" }),
  username: z.string().trim().min(1, "El nombre de usuario es requerido").optional().nullable().or(z.literal("")),
  pin: z.string().regex(/^\d{4}$/, "El PIN debe tener 4 dígitos").optional().nullable().or(z.literal("")),
  password: z.string().trim().min(4, "Mínimo 4 caracteres").nullable().or(z.literal("")),
  role: z.enum(["ADMIN", "STAFF"], { message: "El rol debe ser ADMIN o STAFF" }),
  registeredAt: z.date({ message: "La fecha de registro es requerida" }),
  active: z.boolean({ message: "El campo activo es requerido" }),
});

export type Bill = z.infer<typeof BillSchema>;
export type Customer = z.infer<typeof CustomerSchema>;
export type Debtors = z.infer<typeof DebtorsSchema>;
export type Product = z.infer<typeof ProductSchema>;
export type Recipes = z.infer<typeof RecipesSchema>;
export type Salary = z.infer<typeof SalarySchema>;
export type SaleItems = z.infer<typeof SaleItemsSchema>;
export type Sales = z.infer<typeof SalesSchema>;
export type Supply = z.infer<typeof SupplySchema>;
export type User = z.infer<typeof UserSchema>;

export const DebtorListItemSchema = z.object({
  customerID: z.number().int(),
  customerName: z.string().nullable(),
  alias: z.string().nullable(),
  lastConsumption: z.date().nullable().or(z.string().nullable()),
  registeredDate: z.date().nullable().or(z.string().nullable()),
  amount: z.number(),
});
export type DebtorListItem = z.infer<typeof DebtorListItemSchema>;
import { isCalendarDate, calendarDays } from "@/lib/analytics";

export const AnalyticsFilterSchema = z.object({
  from: z.string().refine(isCalendarDate, "La fecha inicial es inválida"),
  to: z.string().refine(isCalendarDate, "La fecha final es inválida"),
}).refine(value => value.from <= value.to, {
  message: "La fecha inicial debe ser anterior o igual a la fecha final",
}).refine(value => calendarDays(value.from, value.to) <= 366, {
  message: "El rango de fechas no puede superar 366 días",
});
export const ReportTypeSchema = z.enum(["sales", "products", "expenses", "salaries", "customers", "debts"]);
export const ReportFilterSchema = AnalyticsFilterSchema.safeExtend({ type: ReportTypeSchema });
export const AnalyticsReportSchema = createPaginationSchema({ filters: ReportFilterSchema, sortFields: [] });
