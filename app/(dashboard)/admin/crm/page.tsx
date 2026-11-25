import CRMManager from "./crm-manager";
import MobileCRMManager from "./MobileCRMManager";
import { ResponsiveAdminViews } from "@/components/layout/responsive-admin-views";
import { requirePageCapability } from "@/lib/server-permissions";

export default async function CRMPage() {
    await requirePageCapability("customers.manage");
    return <ResponsiveAdminViews desktop={<CRMManager />} mobile={<MobileCRMManager />} />;
}
