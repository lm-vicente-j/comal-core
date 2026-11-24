import { z } from "zod";
import type { ActionResult } from "@/lib/action-result";

export const DEFAULT_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 50;
export const PAGE_SIZE_OPTIONS = [10, 20, 50] as const;

export type PaginationError = "UNAUTHENTICATED" | "FORBIDDEN" | "INVALID_INPUT" | "QUERY_FAILED";
export interface PaginationOptions<F = Record<string, unknown>, S extends string = string> {
    page?: number;
    pageSize?: number;
    search?: string;
    filters?: F;
    sort?: S;
    order?: "asc" | "desc";
}
export interface PaginatedResult<T> {
    items: T[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
    hasMore: boolean;
}
export type NormalizedPagination<F = Record<string, unknown>, S extends string = string> = Required<Pick<PaginationOptions<F, S>, "page" | "pageSize" | "search" | "filters">> & Pick<PaginationOptions<F, S>, "sort" | "order">;
export type PageResult<T> = ActionResult<PaginatedResult<T>, PaginationError>;

function positiveInteger(value: unknown, fallback: number): number {
    const parsed = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
    return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function createPaginationSchema<F extends z.ZodType = z.ZodRecord<z.ZodString, z.ZodUnknown>>(
    config: { filters?: F; sortFields?: readonly string[]; defaultSort?: string; defaultOrder?: "asc" | "desc" } = {},
) {
    const filterSchema = config.filters ?? z.object({}).strict();
    return z.object({
        page: z.preprocess(value => positiveInteger(value, 1), z.number().int().positive().safe()),
        pageSize: z.preprocess(value => Math.min(MAX_PAGE_SIZE, positiveInteger(value, DEFAULT_PAGE_SIZE)), z.number().int().min(1).max(MAX_PAGE_SIZE)),
        search: z.string().trim().max(100).default(""),
        filters: z.preprocess(value => value ?? {}, filterSchema) as z.ZodType<z.output<F>>,
        sort: z.string().refine(value => !config.sortFields || config.sortFields.includes(value), "Invalid sort field").optional().transform(value => value ?? config.defaultSort),
        order: z.enum(["asc", "desc"]).optional()
            .refine(value => value === undefined || config.sortFields?.length !== 0, "Ordering is not supported for this list")
            .transform(value => value ?? config.defaultOrder),
    });
}

export const PaginationOptionsSchema = createPaginationSchema();

export function getPaginationMeta(total: number, options: Pick<PaginationOptions, "page" | "pageSize"> = {}): Omit<PaginatedResult<never>, "items"> {
    if (!Number.isSafeInteger(total) || total < 0) throw new RangeError("Invalid pagination count");
    const pageSize = Math.min(MAX_PAGE_SIZE, positiveInteger(options.pageSize, DEFAULT_PAGE_SIZE));
    const totalPages = Math.ceil(total / pageSize);
    const page = Math.min(positiveInteger(options.page, 1), Math.max(1, totalPages));
    return { total, page, pageSize, totalPages, hasMore: page < totalPages };
}

export function getPaginationOffset({ page, pageSize }: { page: number; pageSize: number }): number {
    const offset = (page - 1) * pageSize;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("Invalid pagination offset");
    return offset;
}

export function emptyPage<T>(pageSize = DEFAULT_PAGE_SIZE): PaginatedResult<T> {
    return { items: [], ...getPaginationMeta(0, { pageSize }) };
}

export function escapeListSearch(search: string): string {
    return search.replace(/[\\%_]/g, "\\$&");
}
