"use client";

import { useSyncExternalStore, type ReactNode } from "react";

const subscribe = (notify: () => void) => {
    const query = window.matchMedia("(min-width: 768px)");
    query.addEventListener("change", notify);
    return () => query.removeEventListener("change", notify);
};
const desktop = () => window.matchMedia("(min-width: 768px)").matches;
const server = () => false;

/** Mount only the current layout so its list is fetched once. */
export function ResponsiveAdminViews({ mobile, desktop: desktopView }: { mobile: ReactNode; desktop: ReactNode }) {
    const isDesktop = useSyncExternalStore(subscribe, desktop, server);
    return isDesktop ? <div className="hidden md:flex h-full w-full">{desktopView}</div>
        : <div className="flex md:hidden min-h-0 w-full flex-1 flex-col overflow-hidden">{mobile}</div>;
}
