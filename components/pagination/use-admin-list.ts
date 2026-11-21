"use client";

import { useEffect, useState } from "react";
import type { PaginationState, Updater } from "@tanstack/react-table";
import type { AdminListPage, AdminListQuery } from "./schema";

const emptyPage = { rows: [], total: 0, page: 1 };

export function useAdminList<T>(
    initialPage: AdminListPage<T>,
    loadPage: (query: AdminListQuery) => Promise<AdminListPage<T>>,
    search: string,
    sort?: string,
    desc?: boolean,
) {
    const criteria = JSON.stringify([search, sort, desc]);
    const [position, setPosition] = useState({ criteria, page: 1 });
    const [revision, setRevision] = useState(0);
    if (position.criteria !== criteria) setPosition({ criteria, page: 1 });
    const page = position.criteria === criteria ? position.page : 1;
    const request = JSON.stringify([criteria, page, revision]);
    const isInitialPage = revision === 0 && page === 1 && !search && sort === undefined;
    const [result, setResult] = useState<{
        request: string;
        initialPage: AdminListPage<T>;
        data: AdminListPage<T>;
    } | null>(null);
    const currentResult = result?.request === request && result.initialPage === initialPage ? result.data : null;
    const data = isInitialPage ? initialPage : currentResult ?? emptyPage;
    const loading = !isInitialPage && currentResult === null;

    useEffect(() => {
        if (isInitialPage) return;
        let cancelled = false;
        let retryDelay = 1000;
        const load = async () => {
            try {
                const data = await loadPage({ page, search, sort, desc });
                if (!cancelled) setResult({ request, initialPage, data });
            } catch {
                if (cancelled) return;
                timer = setTimeout(load, retryDelay);
                retryDelay = Math.min(retryDelay * 2, 5000);
            }
        };
        let timer = setTimeout(load, 125);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [initialPage, loadPage, isInitialPage, page, request, search, sort, desc]);

    const setPage = (nextPage: number) => setPosition({ criteria, page: nextPage });
    const pagination = { pageIndex: data.page - 1, pageSize: 10 };
    return {
        ...data,
        loading,
        invalidate: () => setRevision((current) => current + 1),
        setPage,
        pagination,
        onPaginationChange: (update: Updater<PaginationState>) => {
            const next = typeof update === "function" ? update(pagination) : update;
            setPage(next.pageIndex + 1);
        },
    };
}
