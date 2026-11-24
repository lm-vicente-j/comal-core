import CRMManager from "./crm-manager";
import MobileCRMManager from "./MobileCRMManager";
import { ResponsiveAdminViews } from "@/components/layout/responsive-admin-views";

export default function CRMPage() {
    return <ResponsiveAdminViews desktop={<CRMManager />} mobile={<MobileCRMManager />} />;
}
