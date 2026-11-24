import { InventoryManager } from "./inventory-manager";
import { MobileInventoryManager } from "./MobileInventoryManager";
import { ResponsiveAdminViews } from "@/components/layout/responsive-admin-views";

export default function InventoryPage() {
    return <ResponsiveAdminViews desktop={<InventoryManager />} mobile={<MobileInventoryManager />} />;
}
