"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PaginationState, Updater } from "@tanstack/react-table";
import { getAutoRefreshTick, subscribeAutoRefresh } from "@/components/layout/auto-refresh";
import type { AdminListPage, AdminListQuery } from "./schema";

const emptyPage = { rows: [], total: 0, page: 1 };

function serializePage<T>(page: AdminListPage<T>) {
    return JSON.stringify(page);
}

type StoredResult<T> = {
    criteria: string;
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
    const [failedRequest, setFailedRequest] = useState<string | null>(null);

    if (failedRequest !== null && failedRequest !== request) {
        setFailedRequest(null);
    }

    if (stableInitial.signature !== initialSignature) {
        setStableInitial({ signature: initialSignature, data: initialPage });
        if (isInitialPage && result?.request === request && result.signature !== initialSignature) {
            setResult(null);
        }
    }

    const currentResult = result?.request === request ? result : null;
    const preservedTotal = result?.criteria === criteria
        ? result.data.total
        : (!search && sort === undefined ? stableInitial.data.total : 0);
    const maxPreservedPage = Math.max(1, Math.ceil(preservedTotal / 10));
    const fallbackPage = preservedTotal > 0 ? Math.min(page, maxPreservedPage) : page;
    const data = isInitialPage
        ? currentResult?.data ?? stableInitial.data
        : currentResult?.data ?? { ...emptyPage, page: fallbackPage, total: preservedTotal };
    const loading = !isInitialPage && currentResult === null;
    const retrying = loading && failedRequest === request;

    const autoRefreshTick = useSyncExternalStore(
        subscribeAutoRefresh,
        getAutoRefreshTick,
        getAutoRefreshTick,
    );
    const lastSilentRef = useRef(0);
    const lastAutoRefreshRef = useRef(autoRefreshTick);
    const hasInitialOverrideRef = useRef(false);
    const clampedRequestRef = useRef<string | null>(null);
    const initialSignatureRef = useRef(initialSignature);

    useEffect(() => {
        initialSignatureRef.current = initialSignature;
    }, [initialSignature]);

    useEffect(() => {
        const isSilentTrigger = silentRevision !== lastSilentRef.current;
        const isAutoRefreshTrigger = autoRefreshTick !== lastAutoRefreshRef.current;
        if (isInitialPage && !isSilentTrigger && !hasInitialOverrideRef.current) {
            lastAutoRefreshRef.current = autoRefreshTick;
            clampedRequestRef.current = null;
            return;
        }
        // Skip re-fetching a clamped page transition unless an explicit refresh
        // or AutoRefresh tick specifically requested a fresh read.
        if (!isSilentTrigger && !isAutoRefreshTrigger && clampedRequestRef.current === request) {
            return;
        }
        clampedRequestRef.current = null;
        let cancelled = false;
        let retryDelay = 1000;
        const load = async () => {
            try {
                const nextData = await loadPage({ page, search, sort, desc });
                if (cancelled) return;
                setFailedRequest((prev) => (prev === request ? null : prev));
                lastSilentRef.current = silentRevision;
                lastAutoRefreshRef.current = autoRefreshTick;
                const resolvedPage = nextData.page;
                const resolvedRequest = resolvedPage === page
                    ? request
                    : JSON.stringify([criteria, resolvedPage, revision]);
                if (resolvedPage !== page) {
                    clampedRequestRef.current = resolvedRequest;
                    setPosition((prev) =>
                        prev.criteria === criteria && prev.page === page
                            ? { criteria, page: resolvedPage }
                            : prev
                    );
                }
                const nextSignature = serializePage(nextData);
                if (isInitialPage && resolvedPage === 1 && nextSignature === initialSignatureRef.current) {
                    hasInitialOverrideRef.current = false;
                    setResult((prev) => (prev?.request === resolvedRequest ? null : prev));
                    return;
                }
                hasInitialOverrideRef.current = isInitialPage && resolvedPage === 1;
                setResult((prev) => {
                    if (prev && prev.request === resolvedRequest && prev.signature === nextSignature) {
                        return prev;
                    }
                    return { criteria, request: resolvedRequest, signature: nextSignature, data: nextData };
                });
            } catch {
                if (cancelled) return;
                setFailedRequest(request);
                timer = setTimeout(load, retryDelay);
                retryDelay = Math.min(retryDelay * 2, 5000);
            }
        };
        let timer = setTimeout(load, 125);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [autoRefreshTick, loadPage, isInitialPage, criteria, page, revision, request, search, sort, desc, silentRevision]);

    const setPage = (nextPage: number) => setPosition({ criteria, page: nextPage });
    const pagination = { pageIndex: data.page - 1, pageSize: 10 };
    return {
        ...data,
        loading,
        retrying,
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
