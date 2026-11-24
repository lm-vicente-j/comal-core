"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, type PaginationOptions } from "@/lib/pagination";

type ListState = { query: PaginationOptions; tab?: string };
type Config = { filterKeys?: readonly string[]; defaultSort?: string; defaultOrder?: "asc" | "desc"; defaultTab?: string; defaultFilters?: Record<string, unknown> };
const listeners = new Set<() => void>();
const snapshots = new Map<string, { serialized: string; value: ListState }>();
const STATE_KEY = "comalPagination";

/** Transfer context between list screens without placing filters in the URL. */
export function preparePaginationNavigation(path: string, query: PaginationOptions, tab?: string): void {
    const next: ListState = { query: { page: 1, pageSize: DEFAULT_PAGE_SIZE, search: "", filters: {}, ...query }, tab };
    window.history.replaceState({ ...window.history.state, [STATE_KEY]: { ...window.history.state?.[STATE_KEY], [path]: next } }, "");
    try { sessionStorage.setItem(`${STATE_KEY}:${path}`, JSON.stringify(next)); } catch { /* History still carries the context. */ }
    snapshots.delete(path);
}

function emit() { for (const listener of listeners) listener(); }
function subscribe(listener: () => void) {
    listeners.add(listener);
    window.addEventListener("popstate", listener);
    return () => { listeners.delete(listener); window.removeEventListener("popstate", listener); };
}

function readState(path: string, fallback: ListState): ListState {
    let value: ListState | undefined = window.history.state?.[STATE_KEY]?.[path];
    if (!value) {
        try { value = JSON.parse(sessionStorage.getItem(`${STATE_KEY}:${path}`) ?? "null") ?? undefined; } catch { /* Storage may be unavailable. */ }
    }
    if (!value || typeof value !== "object" || !value.query || typeof value.query !== "object") value = fallback;
    const serialized = JSON.stringify(value);
    const cached = snapshots.get(path);
    if (cached?.serialized === serialized) return cached.value;
    snapshots.set(path, { serialized, value });
    return value;
}

/** Route-local navigation state. Reads always travel in Server Action POST bodies. */
export function usePaginationState(config: Config = {}) {
    const pathname = usePathname();
    const configKey = JSON.stringify(config);
    const defaults = useMemo<ListState>(() => {
        const settings: Config = JSON.parse(configKey);
        return { tab: settings.defaultTab, query: { page: 1, pageSize: DEFAULT_PAGE_SIZE, search: "", filters: settings.defaultFilters ?? {}, sort: settings.defaultSort, order: settings.defaultOrder } };
    }, [configKey]);
    const getSnapshot = useCallback(() => readState(pathname, defaults), [pathname, defaults]);
    const getServerSnapshot = useCallback(() => defaults, [defaults]);
    const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

    const update = useCallback((change: (previous: ListState) => ListState, replace = false) => {
        const previous = readState(pathname, defaults);
        const next = change(previous);
        if (JSON.stringify(previous) === JSON.stringify(next)) return;
        // Retain the initial position so the first Back also restores page one.
        if (!window.history.state?.[STATE_KEY]?.[pathname]) {
            window.history.replaceState({ ...window.history.state, [STATE_KEY]: { ...window.history.state?.[STATE_KEY], [pathname]: previous } }, "", pathname);
        }
        const historyState = { ...window.history.state, [STATE_KEY]: { ...window.history.state?.[STATE_KEY], [pathname]: next } };
        if (replace) window.history.replaceState(historyState, "", pathname);
        else window.history.pushState(historyState, "", pathname);
        try { sessionStorage.setItem(`${STATE_KEY}:${pathname}`, JSON.stringify(next)); } catch { /* Navigation still works without storage. */ }
        emit();
    }, [pathname, defaults]);

    return {
        query: state.query,
        tab: state.tab,
        setPage: useCallback((page: number) => update(old => ({ ...old, query: { ...old.query, page } })), [update]),
        replacePage: useCallback((page: number) => update(old => ({ ...old, query: { ...old.query, page } }), true), [update]),
        setPageSize: useCallback((pageSize: number) => update(old => ({ ...old, query: { ...old.query, page: 1, pageSize: Math.min(MAX_PAGE_SIZE, Math.max(1, pageSize)) } })), [update]),
        setSearch: useCallback((search: string) => update(old => ({ ...old, query: { ...old.query, page: 1, search } }), true), [update]),
        setSort: useCallback((sort?: string, order?: "asc" | "desc") => update(old => ({ ...old, query: { ...old.query, page: 1, sort, order } })), [update]),
        setFilters: useCallback((filters: Record<string, unknown>) => update(old => ({ ...old, query: { ...old.query, page: 1, filters: { ...old.query.filters, ...filters } } })), [update]),
        setTab: useCallback((tab: string) => update(old => ({ tab, query: { ...defaults.query, pageSize: old.query.pageSize } })), [update, defaults]),
        // Used only as a presentation fallback; onClick is always handled locally.
        getPageHref: useCallback(() => pathname, [pathname]),
    };
}
