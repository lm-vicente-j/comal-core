import { requireAnyPageCapability } from "@/lib/server-permissions";
import ExpensesManager from "./expenses-manager";

export default async function ExpensesPage() {
    const authorization = await requireAnyPageCapability(["expenses.create", "reports.operational"]);
    return <ExpensesManager canCreate={authorization.permissions["expenses.create"]} />;
}
