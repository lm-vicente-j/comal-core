import { z } from "zod";

export const createPaginationSchema = <T extends z.ZodTypeAny>(filterSchema?: T) =>
  z.object({
    page: z.coerce.number().int().positive().default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(10), // Limit between 1 and 50
    search: z.string().trim().max(100).optional().default(""),     // Maximum 100 characters
    filters: filterSchema ? filterSchema.optional() : z.record(z.string(), z.any()).optional(),
  });

export const PaginationOptionsSchema = createPaginationSchema();
