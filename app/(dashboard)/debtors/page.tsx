import DebtorsManager from "./debtors-manager";
import { getDebtsSummary } from "@/lib/actions/debts";
import { hasOpenJornada } from "@/lib/actions/jornada";

export default async function DebtorsPage() {
  const [summary, jornadaOpen] = await Promise.all([
    getDebtsSummary(),
    hasOpenJornada(),
  ]);

  return (
    <DebtorsManager
      initialSummary={summary}
      jornadaOpen={jornadaOpen}
    />
  );
}
