import StatisticsManager from "./statistics-manager";
import { requirePageCapability } from "@/lib/server-permissions";

export default async function StatisticsPage() {
    await requirePageCapability("reports.operational");
    return <div className="w-full max-w-6xl mx-auto p-4 md:p-6 space-y-6"><StatisticsManager /></div>;
}
