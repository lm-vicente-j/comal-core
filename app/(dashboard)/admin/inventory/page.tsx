import { InventoryManager } from "./inventory-manager";
import { MobileInventoryManager } from "./MobileInventoryManager";
import { ResponsiveAdminViews } from "@/components/layout/responsive-admin-views";
import { requirePageCapability } from "@/lib/server-permissions";

export default async function InventoryPage() {
    await requirePageCapability("inventory.manage");
    return <ResponsiveAdminViews desktop={<InventoryManager />} mobile={<MobileInventoryManager />} />;
}
