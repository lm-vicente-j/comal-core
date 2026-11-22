"use client";

import { useEffect, useRef, useState } from "react";
import type { PaginationState, Updater } from "@tanstack/react-table";
import type { AdminListPage, AdminListQuery } from "./schema";

const emptyPage = { rows: [], total: 0, page: 1 };

function serializePage<T>(page: AdminListPage<T>) {
    return JSON.stringify(page);
}

type StoredResult<T> = {
    request: string;
    signature: string;
    data: AdminListPage<T>;
};

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
    const [silentRevision, setSilentRevision] = useState(0);
    if (position.criteria !== criteria) setPosition({ criteria, page: 1 });
    const page = position.criteria === criteria ? position.page : 1;
    const request = JSON.stringify([criteria, page, revision]);
    const isInitialPage = revision === 0 && page === 1 && !search && sort === undefined;

    const initialSignature = serializePage(initialPage);
    const [stableInitial, setStableInitial] = useState<{
        signature: string;
        data: AdminListPage<T>;
    }>(() => ({ signature: initialSignature, data: initialPage }));
    const [result, setResult] = useState<StoredResult<T> | null>(null);

    if (stableInitial.signature !== initialSignature) {
        setStableInitial({ signature: initialSignature, data: initialPage });
        if (isInitialPage && result?.request === request && result.signature !== initialSignature) {
            setResult(null);
        }
    }

    const currentResult = result?.request === request ? result : null;
    const data = isInitialPage
        ? currentResult?.data ?? stableInitial.data
        : currentResult?.data ?? emptyPage;
    const loading = !isInitialPage && currentResult === null;

    const lastSilentRef = useRef(0);
    const hasInitialOverrideRef = useRef(false);

    useEffect(() => {
        const isSilentTrigger = silentRevision !== lastSilentRef.current;
        if (isInitialPage && !isSilentTrigger && !hasInitialOverrideRef.current) return;
        let cancelled = false;
        let retryDelay = 1000;
        const load = async () => {
            try {
                const nextData = await loadPage({ page, search, sort, desc });
                if (cancelled) return;
                lastSilentRef.current = silentRevision;
                const nextSignature = serializePage(nextData);
                if (isInitialPage && nextSignature === initialSignature) {
                    hasInitialOverrideRef.current = false;
                    setResult((prev) => (prev?.request === request ? null : prev));
                    return;
                }
                hasInitialOverrideRef.current = isInitialPage;
                setResult((prev) => {
                    if (prev && prev.request === request && prev.signature === nextSignature) {
                        return prev;
                    }
                    return { request, signature: nextSignature, data: nextData };
                });
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
    }, [initialPage, initialSignature, loadPage, isInitialPage, page, request, search, sort, desc, silentRevision]);

    const setPage = (nextPage: number) => setPosition({ criteria, page: nextPage });
    const pagination = { pageIndex: data.page - 1, pageSize: 10 };
    return {
        ...data,
        loading,
        invalidate: () => setRevision((current) => current + 1),
        refresh: () => setSilentRevision((current) => current + 1),
        setPage,
        pagination,
        onPaginationChange: (update: Updater<PaginationState>) => {
            const next = typeof update === "function" ? update(pagination) : update;
            setPage(next.pageIndex + 1);
        },
    };
}
