import { MenuManager } from "./menu-manager";
import { MobileMenuManager } from "./MobileMenuManager";
import { ResponsiveAdminViews } from "@/components/layout/responsive-admin-views";
import { requirePageCapability } from "@/lib/server-permissions";

export default async function MenuPage() {
    await requirePageCapability("catalog.manage");
    return <ResponsiveAdminViews desktop={<MenuManager />} mobile={<MobileMenuManager />} />;
}
