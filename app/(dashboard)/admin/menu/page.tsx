import { MenuManager } from "./menu-manager";
import { MobileMenuManager } from "./MobileMenuManager";
import { ResponsiveAdminViews } from "@/components/layout/responsive-admin-views";

export default function MenuPage() {
    return <ResponsiveAdminViews desktop={<MenuManager />} mobile={<MobileMenuManager />} />;
}
