import { z } from "zod";

const parsePaginationInt = (val: unknown) => {
  if (typeof val === "number") return val;
  if (typeof val === "string" && val.trim() !== "") return Number(val);
  if (val === undefined) return undefined;
  return NaN;
};

export const createPaginationSchema = <T extends z.ZodTypeAny>(filterSchema?: T) =>
  z.object({
    page: z.preprocess(parsePaginationInt, z.number().int().positive().default(1)),
    pageSize: z.preprocess(parsePaginationInt, z.number().int().min(1).max(50).default(10)), // Limit between 1 and 50
    search: z.string().trim().max(100).optional().default(""),     // Maximum 100 characters
    filters: filterSchema ? filterSchema.optional() : z.record(z.string(), z.any()).optional(),
  });

export const PaginationOptionsSchema = createPaginationSchema();

export const AdminListQuerySchema = PaginationOptionsSchema.extend({
  page: PaginationOptionsSchema.shape.page.pipe(z.number().max(10_000_000)),
  sort: z.string().max(40).optional(),
  desc: z.boolean().optional(),
});

export type AdminListQuery = z.input<typeof AdminListQuerySchema>;

export type AdminListPage<T> = { rows: T[]; total: number; page: number };

export function escapeListSearch(search: string) {
  return search.replace(/[\\%_]/g, "\\$&");
}
