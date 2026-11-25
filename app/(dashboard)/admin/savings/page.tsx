import { getPoolBalance } from "@/lib/actions/savings";
import { hasOpenJornada } from "@/lib/actions/jornada";
import SavingsManager from "./savings-manager";
import { requireAnyPageCapability } from "@/lib/server-permissions";

export default async function SavingsPage() {
    const authorization = await requireAnyPageCapability(["savings.deposit", "savings.manage"]);
    const [pool, jornadaOpen] = await Promise.all([getPoolBalance(), hasOpenJornada()]);
    return <div className="w-full max-w-5xl mx-auto p-4 md:p-6 space-y-6"><SavingsManager pool={pool} jornadaOpen={jornadaOpen} isOwner={authorization.role === "ADMIN"} canDeposit={authorization.permissions["savings.deposit"]} /></div>;
}
