import {
  getActiveJornadaWithStats,
  getJornadaEmployeeBreakdown,
  getJornadaCollectionsByEmployee,
  getCashCountHistory,
  getOpenJornadaId,
} from "@/lib/actions/jornada";
import JornadaManager from "./jornada-manager";
import { requireAnyPageCapability } from "@/lib/server-permissions";
import { hasOpenJornada } from "@/lib/actions/jornada";

export default async function JornadasPage() {
  const authorization = await requireAnyPageCapability([
    "jornada.open",
    "jornada.close",
    "jornada.reconcile",
    "jornada.viewCash",
  ]);
  const [data, jornadaOpen, activeJornadaId] = await Promise.all([
    getActiveJornadaWithStats(),
    hasOpenJornada(),
    getOpenJornadaId(),
  ]);

  // load if there is an active jornada
  const employees =
    data && data.state !== "NO_JORNADA"
      ? await getJornadaEmployeeBreakdown(data.jornada.id)
      : [];
  const [collections, history] = await Promise.all([
    data && data.state !== "NO_JORNADA"
      ? getJornadaCollectionsByEmployee(data.jornada.id)
      : Promise.resolve([]),
    getCashCountHistory({ page: 1, pageSize: 10 }),
  ]);

  return (
    <div className="w-full max-w-5xl mx-auto p-6">
      <JornadaManager
        data={data}
        employees={employees}
        collections={collections}
        history={history}
        permissions={authorization.permissions}
        isOwner={authorization.role === "ADMIN"}
        jornadaOpen={jornadaOpen}
        activeJornadaId={activeJornadaId}
      />
    </div>
  );
}
