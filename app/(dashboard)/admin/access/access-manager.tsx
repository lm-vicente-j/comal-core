"use client";

import { accessMessage } from "@/lib/access-messages";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { DataPagination, PaginationErrorState, usePaginatedTable, usePaginationState } from "@/components/pagination";
import { Save, ShieldX, UserCheck, UserX, KeyRound } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getStaffPage, createStaff, regenerateStaffPin, saveUser } from "@/lib/actions/users";
import { approveTerminalRequest, listTerminalRequests, listTerminals, revokeTerminal, updateTerminal } from "@/lib/actions/terminal";
import { getRolePermissions, saveRolePermissions } from "@/lib/actions/security";
import { CAPABILITIES, DEFAULT_ROLE_PERMISSIONS, isConfigurable, type Capability, type RolePermissions } from "@/lib/permissions";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

type StaffUser = { id: number; name: string | null; username: string | null; role: "SUPERVISOR" | "STAFF" | "ADMIN"; active: boolean | null; hasPin: boolean };
type Terminal = { id: string; name: string; type: "FIXED" | "MOBILE"; createdAt: string; active: boolean };
type TerminalRequest = { id: string; createdAt: string; expiresAt: string };

const inputClass = "min-h-10 min-w-0 w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50";
const buttonClass = "min-h-10 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60";
const iconButtonClass = "inline-flex size-10 shrink-0 items-center justify-center rounded-md border border-input bg-card text-foreground hover:bg-muted disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring";
const secondaryButton = "min-h-10 rounded-md border border-input bg-card px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-60";

type Confirmation = { title: string; description: string; changes?: string[]; confirmLabel: string; destructive?: boolean; run: () => Promise<true | string> };

function ConfirmationDialog({ confirmation, busy, onBusyChange, onClose }: { confirmation: Confirmation | null; busy: boolean; onBusyChange: (busy: boolean) => void; onClose: () => void }) {
  const descriptionId = useId();
  const running = useRef(false);
  const [failure, setFailure] = useState("");
  function dismiss() { setFailure(""); onClose(); }
  async function confirm() {
    if (!confirmation || running.current) return;
    running.current = true;
    setFailure("");
    onBusyChange(true);
    try {
      const result = await confirmation.run();
      if (result === true) dismiss();
      else setFailure(result);
    }
    catch { setFailure("No se pudo completar el cambio. Intenta de nuevo."); }
    finally { running.current = false; onBusyChange(false); }
  }
  return <AlertDialog open={!!confirmation} onOpenChange={(open) => { if (!open && !running.current) dismiss(); }}>
    <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto" aria-describedby={descriptionId} aria-busy={busy}>
      <AlertDialogHeader><AlertDialogTitle>{confirmation?.title}</AlertDialogTitle><AlertDialogDescription id={descriptionId}>{confirmation?.description}</AlertDialogDescription></AlertDialogHeader>
      {confirmation?.changes && <ul aria-label="Cambios de permisos" className="max-h-48 space-y-2 overflow-y-auto text-sm">{confirmation.changes.map((change) => <li key={change}>{change}</li>)}</ul>}
      {failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}
      <AlertDialogFooter><AlertDialogCancel disabled={busy}>Cancelar</AlertDialogCancel><AlertDialogAction className={confirmation?.destructive ? "bg-destructive text-white hover:bg-destructive/90" : undefined} disabled={busy} onClick={(event) => { event.preventDefault(); void confirm(); }}>{busy ? "Aplicando…" : confirmation?.confirmLabel}</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}

export default function AccessManager() {
  const staffState = usePaginationState({ defaultSort: "name", defaultOrder: "asc" });
  const staffPage = usePaginatedTable(staffState, getStaffPage);
  const users = staffPage.items as StaffUser[];
  const refreshStaff = staffPage.refresh;
  const [terminals, setTerminals] = useState<Terminal[]>([]);
  const [requests, setRequests] = useState<TerminalRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [role, setRole] = useState<"SUPERVISOR" | "STAFF">("STAFF");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [oneTimePin, setOneTimePin] = useState<{ pin: string; username: string; label: string } | null>(null);
  const [nameDrafts, setNameDrafts] = useState<Record<number, string>>({});
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const busy = confirmBusy;

  const refresh = useCallback(async () => {
    setLoading(true);
    refreshStaff();
    const [terminalList, requestList] = await Promise.all([listTerminals(), listTerminalRequests()]);
    setTerminals(terminalList.success ? terminalList.data : []);
    setRequests(requestList.success ? requestList.data : []);
    setLoading(false);
  }, [refreshStaff]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);
  useEffect(() => {
    const timer = window.setInterval(async () => {
      const requestList = await listTerminalRequests();
      if (requestList.success) setRequests(requestList.data);
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  function createUser(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const snapshot = { name: name.trim(), role };
    setConfirmation({ title: "Crear cuenta", description: `Se creará una cuenta para ${snapshot.name} con el rol ${snapshot.role === "STAFF" ? "Servicio" : "Supervisión"}. Se generará un usuario y un PIN.`, confirmLabel: "Crear cuenta", run: async () => {
      setError(""); setNotice(""); setOneTimePin(null);
      const result = await createStaff({ ...snapshot, active: true });
      if (!result.success) { setError(accessMessage(result.error)); return accessMessage(result.error); }
      setOneTimePin({ pin: result.data.pin, username: result.data.username, label: snapshot.name });
      setName("");
      setNotice("Cuenta creada.");
      await refresh();
      return true;
    }});
  }

  function updateStaff(user: StaffUser, changes: { name?: string; role?: "SUPERVISOR" | "STAFF"; active?: boolean }) {
    const snapshot = { id: user.id, ...changes };
    const isNameOnly = changes.name !== undefined && changes.role === undefined && changes.active === undefined;
    const action = changes.name !== undefined ? "Guardar nombre" : changes.role !== undefined ? "Cambiar rol" : changes.active ? "Reactivar cuenta" : "Desactivar cuenta";
    const consequence = isNameOnly ? "La sesión de esta persona seguirá activa." : "Se cerrarán las sesiones de esta persona.";
    const summary = changes.name !== undefined ? `El nombre de ${user.name ?? "esta persona"} cambiará a ${changes.name}.` : changes.role !== undefined ? `${user.name ?? "Esta persona"} tendrá el rol ${changes.role === "STAFF" ? "Servicio" : "Supervisión"}.` : `${user.name ?? "Esta persona"}: se ${changes.active ? "reactivará" : "desactivará"} su cuenta.`;
    setConfirmation({ title: action, description: `${summary} ${consequence}`, confirmLabel: action, destructive: changes.active === false, run: async () => {
      setError(""); setNotice(""); setOneTimePin(null);
      const result = await saveUser(snapshot);
      if (!result.success) { setError(accessMessage(result.error)); return accessMessage(result.error); }
      setNotice(`${user.name ?? "Cuenta"}: cambios guardados.`);
      await refresh();
      return true;
    }});
  }

  function regenerate(user: StaffUser) {
    setConfirmation({ title: "Renovar PIN", description: `Se generará un PIN nuevo para ${user.name ?? "esta persona"}. Su sesión actual se cerrará y tendrá que iniciar sesión de nuevo.`, confirmLabel: "Renovar PIN", run: async () => {
      setError(""); setNotice(""); setOneTimePin(null);
      const result = await regenerateStaffPin(user.id);
      if (!result.success) { setError(accessMessage(result.error)); return accessMessage(result.error); }
      setOneTimePin({ pin: result.data.pin, username: user.username ?? "", label: user.name ?? "esta persona" });
      setNotice("PIN renovado. La persona debe iniciar sesión de nuevo.");
      return true;
    }});
  }

  function approve(request: TerminalRequest, name: string, type: "FIXED" | "MOBILE") {
    const snapshot = { requestId: request.id, name, type };
    setConfirmation({ title: "Autorizar dispositivo", description: `Se autorizará ${name} como dispositivo ${type === "FIXED" ? "fijo" : "móvil"}.`, confirmLabel: "Autorizar", run: async () => {
      setError(""); setNotice("");
      const result = await approveTerminalRequest(snapshot.requestId, snapshot.name, snapshot.type);
      if (!result.success) { setError(accessMessage(result.error)); return accessMessage(result.error); }
      setNotice(`Dispositivo autorizado: ${snapshot.name}.`);
      await refresh();
      return true;
    }});
  }

  function changeTerminal(terminal: Terminal, changes: { name?: string; type?: "FIXED" | "MOBILE" }) {
    const snapshot = { id: terminal.id, ...changes };
    const typeChange = changes.type !== undefined;
    setConfirmation({ title: typeChange ? "Cambiar tipo de dispositivo" : "Guardar nombre", description: typeChange ? `El tipo de ${terminal.name} cambiará a ${changes.type === "FIXED" ? "fijo" : "móvil"}. Se cerrarán las sesiones de personal en este dispositivo.` : `El dispositivo se llamará ${changes.name}. Sus sesiones seguirán activas.`, confirmLabel: typeChange ? "Cambiar tipo" : "Guardar nombre", run: async () => {
      setError(""); setNotice("");
      const result = await updateTerminal(snapshot.id, snapshot.type !== undefined ? { type: snapshot.type } : { name: snapshot.name });
      if (!result.success) { setError(accessMessage(result.error)); return accessMessage(result.error); }
      setNotice("Dispositivo actualizado.");
      await refresh();
      return true;
    }});
  }

  async function removeTerminal(terminal: Terminal) {
    const snapshot = { id: terminal.id, name: terminal.name };
    setConfirmation({ title: "Revocar dispositivo", description: `Se revocará el acceso de ${snapshot.name} y se cerrarán sus sesiones de personal.`, confirmLabel: "Revocar acceso", destructive: true, run: async () => {
      setError(""); setNotice("");
      const result = await revokeTerminal(snapshot.id);
      if (!result.success) { setError(accessMessage(result.error)); return accessMessage(result.error); }
      setNotice(`${snapshot.name}: acceso revocado.`);
      await refresh();
      return true;
    }});
  }

  return (
    <section aria-labelledby="access-heading" className="mx-auto w-full max-w-6xl p-4 sm:p-6 lg:p-8">
      <ConfirmationDialog confirmation={confirmation} busy={confirmBusy} onBusyChange={setConfirmBusy} onClose={() => setConfirmation(null)} />
      <header className="mb-6">
        <h1 id="access-heading" className="mt-1 text-2xl font-bold text-foreground sm:text-3xl">Access</h1>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">Personal, permisos y dispositivos.</p>
      </header>
      {error && <div role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
      {notice && <div role="status" className="mb-4 rounded-lg border border-green-200 bg-green-100 p-3 text-sm text-green-700">{notice}</div>}
      {oneTimePin && <section aria-live="polite" className="mb-6 rounded-xl border-2 border-primary bg-green-100 p-4">
        <h2 className="font-bold text-foreground">PIN de {oneTimePin.label}</h2>
        <p className="mt-1 text-sm text-green-700">Usuario: <strong>{oneTimePin.username}</strong></p>
        <p className="mt-3 font-mono text-3xl font-bold tracking-[0.3em] text-foreground">{oneTimePin.pin}</p>
        <p className="mt-2 text-sm text-green-700">Copia este PIN. No volverá a mostrarse.</p>
      </section>}

      <Tabs defaultValue="staff">
        <TabsList className="grid h-auto w-full grid-cols-3 bg-muted p-1 sm:max-w-xl">
          <TabsTrigger value="staff" className="min-h-11 px-1 text-xs sm:text-sm">Personal</TabsTrigger>
          <TabsTrigger value="roles" aria-label="Permisos" className="min-h-11 px-1 text-xs sm:text-sm">Permisos</TabsTrigger>
          <TabsTrigger value="terminals" className="min-h-11 px-1 text-xs sm:text-sm">Dispositivos</TabsTrigger>
        </TabsList>
        <TabsContent value="staff" className="mt-5 space-y-5">
          <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
            <h2 className="text-lg font-semibold">Agregar persona</h2>
            <p className="mt-1 text-sm text-muted-foreground">El usuario y el PIN se generan al guardar.</p>
            <form onSubmit={createUser} className="mt-4 grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
              <label className="grid gap-1 text-sm font-medium">Nombre y apellidos<input required minLength={3} value={name} onChange={(e) => setName(e.target.value)} className={inputClass} /></label>
              <label className="grid gap-1 text-sm font-medium">Rol<select value={role} onChange={(e) => setRole(e.target.value as "SUPERVISOR" | "STAFF")} className={inputClass}><option value="STAFF">Servicio</option><option value="SUPERVISOR">Supervisión</option></select></label>
              <button disabled={busy || name.trim().length < 3} className={buttonClass}>Crear cuenta</button>
            </form>
          </section>
          <section className="rounded-xl border border-border bg-card">
            <div className="border-b border-border p-4"><h2 className="text-lg font-semibold">Personal</h2><p className="text-sm text-muted-foreground">Los cambios de rol o estado cierran las sesiones de esa persona.</p></div>
            <div className="p-4"><input aria-label="Buscar personal" placeholder="Buscar nombre o usuario" value={staffState.query.search ?? ""} onChange={(event) => staffState.setSearch(event.target.value)} className={`${inputClass} w-full`} /></div>
            {staffPage.loading ? <p className="p-4 text-sm text-muted-foreground">Cargando…</p> : users.length === 0 ? <p className="p-4 text-sm text-muted-foreground">Aún no hay personal.</p> : <ul className="divide-y divide-border">{users.map((user) => <li key={user.id} className="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_minmax(16rem,20rem)] items-start">
              <div className="min-w-0">
                <label htmlFor={`staff-name-${user.id}`} className="block text-xs font-medium text-muted-foreground">Nombre</label>
                <div className="mt-1 flex min-w-0 gap-2">
                  <input id={`staff-name-${user.id}`} aria-label={`Nombre de ${user.name}`} value={nameDrafts[user.id] ?? user.name ?? ""} onChange={(event) => setNameDrafts((current) => ({ ...current, [user.id]: event.target.value }))} className={inputClass} />
                  <button type="button" title="Guardar nombre" aria-label={`Guardar nombre de ${user.name}`} disabled={busy || (nameDrafts[user.id] ?? user.name ?? "").trim().length < 3 || (nameDrafts[user.id] ?? user.name) === user.name} onClick={() => updateStaff(user, { name: (nameDrafts[user.id] ?? user.name ?? "").trim() })} className={iconButtonClass}><Save aria-hidden="true" className="size-4" /></button>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{user.username} · {user.active ? "Activo" : "Inactivo"}</p>
              </div>
              <div className="grid min-w-0 gap-1">
                <label htmlFor={`staff-role-${user.id}`} className="text-xs font-medium text-muted-foreground">Rol</label>
                <div className="flex min-w-0 gap-2">
                  <select id={`staff-role-${user.id}`} aria-label={`Rol de ${user.name}`} value={user.role} disabled={busy || !user.active} onChange={(event) => updateStaff(user, { role: event.target.value as "SUPERVISOR" | "STAFF" })} className={inputClass}><option value="STAFF">Servicio</option><option value="SUPERVISOR">Supervisión</option></select>
                  <button type="button" title={user.active ? "Desactivar cuenta" : "Reactivar cuenta"} aria-label={`${user.active ? "Desactivar" : "Reactivar"} a ${user.name}`} disabled={busy} onClick={() => updateStaff(user, { active: !user.active })} className={iconButtonClass}>{user.active ? <UserX aria-hidden="true" className="size-4" /> : <UserCheck aria-hidden="true" className="size-4" />}</button>
                  <button type="button" title="Renovar PIN" aria-label={`Renovar PIN de ${user.name}`} disabled={busy || !user.active} onClick={() => regenerate(user)} className={iconButtonClass}><KeyRound aria-hidden="true" className="size-4" /></button>
                </div>
              </div>
            </li>)}</ul>}
            {staffPage.error && <PaginationErrorState error={staffPage.error} onRetry={refreshStaff} />}
            <DataPagination {...staffPage} onPageChange={staffPage.setPage} onPageSizeChange={staffPage.setPageSize} isPending={staffPage.loading} totalLabel="personal" />
          </section>
        </TabsContent>
        <TabsContent value="roles" className="mt-5"><RolePermissionPanel /></TabsContent>
        <TabsContent value="terminals" className="mt-5 space-y-5">
          <section className="rounded-xl border border-border bg-card">
            <div className="border-b border-border p-4"><h2 className="text-lg font-semibold">Solicitudes</h2><p className="text-sm text-muted-foreground">Confirma el código con la persona antes de autorizar. Vence en 10 minutos.</p></div>
            <div className="flex justify-end px-4 pt-3"><button type="button" onClick={() => void refresh()} className={secondaryButton}>Actualizar</button></div>
            {loading ? <p className="p-4 text-sm text-muted-foreground">Cargando…</p> : requests.length === 0 ? <p className="p-4 text-sm text-muted-foreground">No hay solicitudes pendientes.</p> : <ul className="divide-y divide-border">{requests.map((request) => <TerminalApproval key={request.id} request={request} onApprove={approve} busy={busy} />)}</ul>}
          </section>
          <section className="rounded-xl border border-border bg-card">
            <div className="border-b border-border p-4"><h2 className="text-lg font-semibold">Dispositivos autorizados</h2><p className="text-sm text-muted-foreground">Cambiar el tipo o revocar el acceso cierra sus sesiones de personal.</p></div>
            {loading ? <p className="p-4 text-sm text-muted-foreground">Cargando…</p> : terminals.length === 0 ? <p className="p-4 text-sm text-muted-foreground">Aún no hay dispositivos autorizados.</p> : <ul className="divide-y divide-border">{terminals.map((terminal) => <TerminalRow key={terminal.id} terminal={terminal} busy={busy} onUpdate={changeTerminal} onRevoke={removeTerminal} />)}</ul>}
          </section>
        </TabsContent>
      </Tabs>
    </section>
  );
}

function TerminalApproval({ request, onApprove, busy }: { request: TerminalRequest; onApprove: (request: TerminalRequest, name: string, type: "FIXED" | "MOBILE") => void; busy: boolean }) {
  const [name, setName] = useState("");
  const [type, setType] = useState<"FIXED" | "MOBILE">("FIXED");
  const expires = new Date(request.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return <li className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-[minmax(10rem,1fr)_minmax(12rem,1fr)_10rem_auto] sm:items-end">
    <div className="min-w-0 sm:col-span-2 xl:col-span-1"><p className="font-medium">Código {request.id.slice(0, 8).toUpperCase()}</p><p className="text-sm text-muted-foreground">Vence a las {expires}</p></div>
    <label className="grid gap-1 text-xs font-medium text-muted-foreground">Nombre del dispositivo<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Caja principal" className={inputClass} /></label>
    <label className="grid gap-1 text-xs font-medium text-muted-foreground">Tipo<select value={type} onChange={(e) => setType(e.target.value as "FIXED" | "MOBILE")} className={inputClass}><option value="FIXED">Fijo</option><option value="MOBILE">Móvil</option></select></label>
    <button disabled={busy || name.trim().length < 2} onClick={() => onApprove(request, name.trim(), type)} className={buttonClass}>Autorizar</button>
  </li>;
}

function TerminalRow({ terminal, busy, onUpdate, onRevoke }: { terminal: Terminal; busy: boolean; onUpdate: (terminal: Terminal, changes: { name?: string; type?: "FIXED" | "MOBILE" }) => void; onRevoke: (terminal: Terminal) => void }) {
  const [name, setName] = useState(terminal.name);
  const fieldId = useId();
  return <li className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(12rem,16rem)]">
    <div className="flex min-w-0 items-start justify-between gap-3 sm:col-span-2"><p className="break-words font-medium">{terminal.name}</p><span className="shrink-0 text-xs text-muted-foreground">{terminal.active ? "Autorizado" : "Acceso revocado"}</span></div>
    <div className="grid min-w-0 gap-1">
      <label htmlFor={`${fieldId}-name`} className="text-xs font-medium text-muted-foreground">Nombre</label>
      <div className="flex min-w-0 gap-2">
        <input id={`${fieldId}-name`} disabled={!terminal.active} value={name} onChange={(event) => setName(event.target.value)} className={inputClass} />
        <button type="button" title="Guardar nombre" aria-label={`Guardar nombre de ${terminal.name}`} disabled={busy || !terminal.active || name.trim().length < 2 || name.trim() === terminal.name} onClick={() => onUpdate(terminal, { name: name.trim() })} className={iconButtonClass}><Save aria-hidden="true" className="size-4" /></button>
      </div>
    </div>
    <div className="grid min-w-0 gap-1">
      <label htmlFor={`${fieldId}-type`} className="text-xs font-medium text-muted-foreground">Tipo de dispositivo</label>
      <div className="flex min-w-0 gap-2">
        <select id={`${fieldId}-type`} value={terminal.type} disabled={busy || !terminal.active} onChange={(event) => onUpdate(terminal, { type: event.target.value as "FIXED" | "MOBILE" })} className={inputClass}><option value="FIXED">Fijo</option><option value="MOBILE">Móvil</option></select>
        <button type="button" title={terminal.active ? "Revocar acceso" : "Acceso revocado"} aria-label={`Revocar dispositivo ${terminal.name}`} disabled={busy || !terminal.active} onClick={() => onRevoke(terminal)} className={`${iconButtonClass} border-destructive/30 text-destructive hover:bg-destructive/10`}><ShieldX aria-hidden="true" className="size-4 text-destructive" /></button>
      </div>
    </div>
  </li>;
}

function RolePermissionPanel() {
  const [drafts, setDrafts] = useState<Record<"SUPERVISOR" | "STAFF", RolePermissions>>({
    SUPERVISOR: DEFAULT_ROLE_PERMISSIONS.SUPERVISOR,
    STAFF: DEFAULT_ROLE_PERMISSIONS.STAFF,
  });
  const [saved, setSaved] = useState<Record<"SUPERVISOR" | "STAFF", RolePermissions>>({
    SUPERVISOR: DEFAULT_ROLE_PERMISSIONS.SUPERVISOR,
    STAFF: DEFAULT_ROLE_PERMISSIONS.STAFF,
  });
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void Promise.all([getRolePermissions("SUPERVISOR"), getRolePermissions("STAFF")]).then(([supervisor, staff]) => {
      if (!active) return;
      if (supervisor.success && staff.success) {
        const result = { SUPERVISOR: supervisor.data, STAFF: staff.data };
        setDrafts(result); setSaved(result);
      } else setError(!supervisor.success ? accessMessage(supervisor.error) : !staff.success ? accessMessage(staff.error) : "No se pudieron cargar los permisos.");
      setLoading(false);
    });
    return () => { active = false; };
  }, []);

  const labels: Record<Capability, { label: string; section: string }> = {
    "sales.create": { label: "Vender y cobrar", section: "Ventas y atención" },
    "sales.managePending": { label: "Cambiar o cancelar ventas pendientes", section: "Ventas y atención" },
    "sales.manageDebt": { label: "Cambiar ventas con deuda", section: "Ventas y atención" },
    "expenses.create": { label: "Registrar gastos", section: "Ventas y atención" },
    "debts.collect": { label: "Cobrar deudas", section: "Ventas y atención" },
    "jornada.open": { label: "Abrir jornada", section: "Caja" },
    "jornada.close": { label: "Cerrar jornada", section: "Caja" },
    "jornada.reconcile": { label: "Registrar arqueos y entregas", section: "Caja" },
    "jornada.viewCash": { label: "Ver efectivo esperado e historial", section: "Caja" },
    "savings.deposit": { label: "Depositar en ahorros", section: "Ahorros y reportes" },
    "savings.manage": { label: "Retirar ahorros y administrar metas", section: "Solo propietario" },
    "reports.operational": { label: "Ver y exportar reportes", section: "Ahorros y reportes" },
    "catalog.manage": { label: "Administrar catálogo", section: "Administración" },
    "inventory.manage": { label: "Administrar inventario", section: "Administración" },
    "customers.manage": { label: "Administrar clientes", section: "Administración" },
    "payrolls.manage": { label: "Administrar nómina", section: "Solo propietario" },
    "settings.manage": { label: "Administrar Access y configuración", section: "Solo propietario" },
  };
  const configurable = (role: "SUPERVISOR" | "STAFF") => CAPABILITIES.filter((capability) => capability !== "jornada.reconcile" && isConfigurable(role, capability));

  function toggle(role: "SUPERVISOR" | "STAFF", capability: Capability, checked: boolean) {
    setDrafts((current) => ({ ...current, [role]: { ...current[role], [capability]: checked } }));
  }
  function save(role: "SUPERVISOR" | "STAFF") {
    const updates: Partial<Record<Capability, boolean>> = {};
    for (const capability of configurable(role)) if (drafts[role][capability] !== saved[role][capability]) updates[capability] = drafts[role][capability];
    if (!Object.keys(updates).length) { setFeedback(`No hay cambios para guardar.`); return; }
    const snapshot = { role, updates: { ...updates }, values: { ...drafts[role] } };
    setConfirmation({ title: "Guardar permisos", description: `Se actualizarán los permisos de todo el rol ${role === "STAFF" ? "Servicio" : "Supervisión"}.`, changes: Object.entries(snapshot.updates).map(([capability, enabled]) => `${labels[capability as Capability].label}: ${enabled ? "habilitado" : "deshabilitado"}`), confirmLabel: "Guardar permisos", run: async () => {
      setError(""); setFeedback("");
      const result = await saveRolePermissions(snapshot.role, snapshot.updates);
      if (!result.success) { setError(accessMessage(result.error)); return accessMessage(result.error); }
      setSaved((current) => ({ ...current, [snapshot.role]: snapshot.values }));
      setFeedback("Permisos guardados.");
      return true;
    }});
  }

  return <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
    <ConfirmationDialog confirmation={confirmation} busy={busy} onBusyChange={setBusy} onClose={() => setConfirmation(null)} />
    <h2 className="text-lg font-semibold">Permisos por rol</h2>
    <p className="mt-1 max-w-3xl text-sm text-muted-foreground">Los cambios se aplican a todo el rol.</p>
    {error && <p role="alert" className="mt-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
    {feedback && <p role="status" className="mt-4 rounded-lg bg-green-100 p-3 text-sm text-green-700">{feedback}</p>}
    {loading ? <p className="py-6 text-sm text-muted-foreground">Cargando…</p> : <div className="mt-5 grid gap-5 xl:grid-cols-2">
      {(["SUPERVISOR", "STAFF"] as const).map((role) => <section key={role} className="rounded-lg border border-border p-4">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">{role === "STAFF" ? "Servicio" : "Supervisión"}</h3></div><button disabled={busy} onClick={() => save(role)} className={buttonClass}>Guardar {role === "STAFF" ? "Servicio" : "Supervisión"}</button></div>
        <div className="mt-4 space-y-5">{[...new Set(configurable(role).map((capability) => labels[capability].section))].map((section) => <fieldset key={section} className="space-y-2"><legend className="mb-2 text-sm font-semibold text-foreground">{section}</legend>
          {configurable(role).filter((capability) => labels[capability].section === section).map((capability) => {
            const checked = !!drafts[role][capability];
            return <label key={capability} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md px-2 py-2 hover:bg-muted">
              <input type="checkbox" checked={checked} disabled={busy} onChange={(e) => toggle(role, capability, e.target.checked)} className="mt-0.5 size-4 accent-primary" />
              <span className="text-sm">{labels[capability].label}</span>
            </label>;
          })}
        </fieldset>)}</div>
      </section>)}
    </div>}
    <details className="mt-5 rounded-lg bg-muted p-4 text-sm text-muted-foreground"><summary className="cursor-pointer font-medium text-foreground">Permisos del propietario</summary><p className="mt-2">Solo el propietario administra personal, dispositivos, nómina, retiros y metas de ahorro, y ventas con deuda. Las ventas pagadas no se pueden modificar.</p></details>
  </section>;
}
