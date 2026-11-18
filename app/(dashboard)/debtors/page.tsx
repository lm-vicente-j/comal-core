import DebtorsManager from "./debtors-manager";
import { getAllDebtors, getDebtsSummary } from "@/lib/actions/debts";
import { hasOpenJornada } from "@/lib/actions/jornada";

export default async function DebtorsPage() {
  const [rawDebtors, summary, jornadaOpen] = await Promise.all([
    getAllDebtors({ page: 1, pageSize: 10 }),
    getDebtsSummary(),
    hasOpenJornada(),
  ]);

  const initialDebtors = JSON.parse(JSON.stringify(rawDebtors));

  return (
    <DebtorsManager
      initialDebtors={initialDebtors}
      initialSummary={summary}
      jornadaOpen={jornadaOpen}
    />
  );
}
