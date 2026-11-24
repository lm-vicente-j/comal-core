"use client";

import type { Updater, PaginationState } from "@tanstack/react-table";
import { usePaginatedResource } from "./use-paginated-resource";
import { DEFAULT_PAGE_SIZE } from "@/lib/pagination";
import type { PaginationOptions, PaginatedResult, PaginationError } from "@/lib/pagination";
import type { ActionResult } from "@/lib/action-result";

type State = ReturnType<typeof import("./use-pagination-state").usePaginationState>;

export function usePaginatedTable<T>(state: State, load: (query: PaginationOptions) => Promise<ActionResult<PaginatedResult<T>, PaginationError>>, enabled = true) {
    const resource = usePaginatedResource(load, state.query, { enabled, onPageClamp: state.replacePage });
    const data = resource.data;
    const pagination = { pageIndex: (data?.page ?? state.query.page ?? 1) - 1, pageSize: data?.pageSize ?? state.query.pageSize ?? DEFAULT_PAGE_SIZE };
    return {
        items: data?.items ?? [], total: data?.total ?? 0, page: data?.page ?? pagination.pageIndex + 1,
        pageSize: pagination.pageSize, totalPages: data?.totalPages ?? 0,
        loading: resource.isPending, retrying: !!resource.error, error: resource.error,
        refresh: resource.refresh, invalidate: resource.refresh, setPage: state.setPage,
        setPageSize: state.setPageSize, pagination,
        onPaginationChange: (update: Updater<PaginationState>) => {
            const next = typeof update === "function" ? update(pagination) : update;
            if (next.pageSize !== pagination.pageSize) state.setPageSize(next.pageSize);
            else state.setPage(next.pageIndex + 1);
        },
    };
}
