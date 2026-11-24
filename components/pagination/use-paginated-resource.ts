"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ActionResult } from "@/lib/action-result";
import { getPaginationMeta, type PaginatedResult, type PaginationError, type PaginationOptions } from "@/lib/pagination";
import { getAutoRefreshTick, subscribeAutoRefresh } from "@/components/layout/auto-refresh";

type Options = { enabled?: boolean; onPageClamp?: (page: number) => void };

/** Runs Server Actions (POST), ignoring responses belonging to older criteria. */
export function usePaginatedResource<T extends PaginatedResult<unknown>>(
    loadPage: (query: PaginationOptions) => Promise<ActionResult<T, PaginationError>>,
    query: PaginationOptions,
    { enabled = true, onPageClamp }: Options = {},
) {
    const key = JSON.stringify(query);
    const [revision, setRevision] = useState(0);
    const tick = useSyncExternalStore(subscribeAutoRefresh, getAutoRefreshTick, getAutoRefreshTick);
    const [state, setState] = useState<{ key: string; result?: ActionResult<T, PaginationError>; loading: boolean; previous?: { criteria: string; data: T } }>(() => ({ key, loading: true }));
    const requestRef = useRef(0);
    const clampedRequest = useRef<{ key: string; revision: number; tick: number } | undefined>(undefined);
    const previousSearch = useRef(query.search);
    const clampRef = useRef(onPageClamp);
    useEffect(() => { clampRef.current = onPageClamp; }, [onPageClamp]);

    useEffect(() => {
        if (!enabled) return;
        if (clampedRequest.current?.key === key && clampedRequest.current.revision === revision && clampedRequest.current.tick === tick) {
            clampedRequest.current = undefined;
            return;
        }
        const requestId = ++requestRef.current;
        let cancelled = false;
        const options: PaginationOptions = JSON.parse(key);
        const delay = previousSearch.current !== options.search ? 300 : 0;
        previousSearch.current = options.search;
        const timer = setTimeout(async () => {
            setState(old => ({ ...old, loading: true }));
            let result: ActionResult<T, PaginationError>;
            try { result = await loadPage(options); }
            catch { result = { success: false, error: "QUERY_FAILED" }; }
            if (cancelled || requestId !== requestRef.current) return;
            const criteria = JSON.stringify({ ...options, page: undefined });
            const mustClamp = result.success && result.data && result.data.page !== (options.page ?? 1) && clampRef.current;
            const resolvedKey = mustClamp && result.data ? JSON.stringify({ ...options, page: result.data.page }) : key;
            setState(old => ({ key: resolvedKey, result, loading: false, previous: result.success && result.data ? { criteria, data: result.data } : old.previous }));
            if (mustClamp && result.data) {
                clampedRequest.current = { key: resolvedKey, revision, tick };
                clampRef.current?.(result.data.page);
            }
        }, delay);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [key, loadPage, enabled, revision, tick]);

    const current = state.key === key ? state.result : undefined;
    // Preserve navigation metadata after a transient query failure. Rows stay
    // hidden, so a failed page can still return to a previous valid page.
    const criteria = JSON.stringify({ ...query, page: undefined });
    const previous = state.previous?.criteria === criteria ? state.previous.data : undefined;
    const navigationPage = previous && (!current || (!current.success && current.error === "QUERY_FAILED"))
        ? { ...previous, ...getPaginationMeta(previous.total, query), items: [] } as T
        : undefined;
    return {
        result: current,
        data: current?.success ? current.data : navigationPage,
        error: current && !current.success ? current.error : undefined,
        // Refresh valid rows silently; initial loads, navigation and retries
        // still expose a pending state and disable the page controls.
        isPending: enabled && (!current || (state.loading && !current.success)),
        refresh: useCallback(() => setRevision(value => value + 1), []),
    };
}
