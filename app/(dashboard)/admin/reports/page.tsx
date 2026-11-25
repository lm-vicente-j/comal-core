import ReportsManager from "./reports-manager";
import { requirePageCapability } from "@/lib/server-permissions";

export default async function ReportsPage() {
    await requirePageCapability("reports.operational");
    return <div className="w-full min-w-0 max-w-6xl mx-auto p-4 md:p-6"><ReportsManager /></div>;
}
