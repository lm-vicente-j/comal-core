"use client";

import { accessMessage } from "@/lib/access-messages";
import { useActionState, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { login } from "@/lib/actions/auth_action";
import { createInitialOwner } from "@/lib/actions/setup";
import { getTerminalLinkStatus, requestTerminalLink } from "@/lib/actions/terminal";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type TerminalStatus = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";

export default function LoginExperience({ setupAvailable }: { setupAvailable: boolean }) {
  const [state, formAction, isLoginPending] = useActionState(login, null);
  const [mode, setMode] = useState("owner");
  const [setupMessage, setSetupMessage] = useState("");
  const [setupError, setSetupError] = useState("");
  const [setupStillAvailable, setSetupStillAvailable] = useState(setupAvailable);
  const [setupPending, startSetup] = useTransition();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [installSecret, setInstallSecret] = useState("");
  const [terminalRequestId, setTerminalRequestId] = useState("");
  const [terminalStatus, setTerminalStatus] = useState<TerminalStatus | null>(null);
  const [terminalMessage, setTerminalMessage] = useState("");
  const [terminalPending, setTerminalPending] = useState(false);
  const [linkBusy, startLink] = useTransition();
  const router = useRouter();

  useEffect(() => {
    if (!terminalRequestId || terminalStatus !== "PENDING") return;
    let live = true;
    const poll = async () => {
      const result = await getTerminalLinkStatus(terminalRequestId);
      if (!live) return;
      if (!result.success) {
        setTerminalMessage(accessMessage(result.error));
        return;
      }
      setTerminalStatus(result.data.status);
      if (result.data.status === "APPROVED") {
        setTerminalMessage(`Dispositivo autorizado: ${result.data.terminal?.name ?? "listo para ingresar"}.`);
        setTerminalPending(false);
      } else if (result.data.status === "REJECTED") {
        setTerminalPending(false);
        setTerminalMessage("Solicitud rechazada. Puedes enviar otra.");
      } else if (result.data.status === "EXPIRED") {
        setTerminalPending(false);
        setTerminalMessage("La solicitud venció. Envía otra.");
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2500);
    return () => { live = false; window.clearInterval(timer); };
  }, [terminalRequestId, terminalStatus]);

  function beginTerminalRequest() {
    setTerminalMessage("");
    startLink(async () => {
      const result = await requestTerminalLink();
      if (!result.success) {
        setTerminalMessage(accessMessage(result.error));
        return;
      }
      setTerminalRequestId(result.data.requestId);
      setTerminalStatus("PENDING");
      setTerminalPending(true);
      setTerminalMessage(`Código ${result.data.requestId.slice(0, 8).toUpperCase()}. Compártelo con el propietario y mantén esta página abierta.`);
    });
  }

  function submitOwnerSetup(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSetupError("");
    setSetupMessage("");
    const formData = new FormData(event.currentTarget);
    startSetup(async () => {
      const result = await createInitialOwner(formData);
      if (!result.success) {
        setSetupError(accessMessage(result.error));
        return;
      }
      setSetupMessage("Cuenta creada. Ingresa con tu correo y contraseña.");
      setSetupStillAvailable(false);
      setMode("owner");
      setPassword("");
      setConfirmPassword("");
      setInstallSecret("");
    });
  }

  const loginError = state && "error" in state ? accessMessage(state.error) : "";

  return (
    <main className="min-h-dvh bg-muted px-4 py-8 text-foreground sm:grid sm:place-items-center">
      <section className="mx-auto w-full max-w-lg rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-8">
        <div className="mb-7">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-orange-500">Comal Core</p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">Iniciar sesión</h1>
        </div>

        {setupStillAvailable && (
          <div className="mb-5 rounded-xl border border-border bg-muted p-4">
            <h2 className="font-semibold">Primera instalación</h2>
            <p className="mt-1 text-sm text-foreground">Crea la cuenta del propietario.</p>
            <form onSubmit={submitOwnerSetup} className="mt-4 grid gap-3">
              <Field label="Nombre del propietario"><input name="name" required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} className={inputClass} /></Field>
              <Field label="Correo"><input name="email" required type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} /></Field>
              <Field label="Contraseña"><input name="password" required type="password" minLength={12} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} /><span className="text-xs text-muted-foreground">Mínimo 12 caracteres.</span></Field>
              <Field label="Confirmar contraseña"><input name="confirmPassword" required type="password" autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} className={inputClass} /></Field>
              <Field label="Clave de instalación"><input name="installSecret" required type="password" autoComplete="off" value={installSecret} onChange={(e) => setInstallSecret(e.target.value)} className={inputClass} /><span className="text-xs text-muted-foreground">Pídela a quien instaló Comal Core.</span></Field>
              {setupError && <p role="alert" className="text-sm text-destructive">{setupError}</p>}
              {setupMessage && <p role="status" className="text-sm text-green-700">{setupMessage}</p>}
              <button disabled={setupPending} className={primaryButton}>{setupPending ? "Creando…" : "Crear propietario"}</button>
            </form>
          </div>
        )}

        {setupMessage && !setupStillAvailable && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-100 p-3 text-sm text-green-700">{setupMessage}</p>}

        <Tabs value={mode} onValueChange={setMode}>
          <TabsList className="grid h-auto w-full grid-cols-3 bg-muted p-1">
            <TabsTrigger className="min-h-11 px-1 text-xs sm:text-sm" value="owner">Propietario</TabsTrigger>
            <TabsTrigger aria-label="Dispositivo fijo" className="min-h-11 px-1 text-xs sm:text-sm" value="fixed">Fijo</TabsTrigger>
            <TabsTrigger aria-label="Dispositivo móvil" className="min-h-11 px-1 text-xs sm:text-sm" value="mobile">Móvil</TabsTrigger>
          </TabsList>
          <TabsContent value="owner">
            <form action={formAction} className="mt-5 grid gap-4">
              <Field label="Correo"><input required type="email" name="email" autoComplete="username" className={inputClass} /></Field>
              <Field label="Contraseña"><input required type="password" name="password" autoComplete="current-password" className={inputClass} /></Field>
              {loginError && <p role="alert" className="text-sm text-destructive">{loginError}</p>}
              <button disabled={isLoginPending} className={primaryButton}>{isLoginPending ? "Ingresando…" : "Ingresar"}</button>
            </form>
          </TabsContent>
          {(["fixed", "mobile"] as const).map((terminalMode) => (
            <TabsContent key={terminalMode} value={terminalMode}>
              <form action={formAction} className="mt-5 grid gap-4">
                <input type="hidden" name="authMode" value={terminalMode === "fixed" ? "FIXED_PIN" : "MOBILE_PIN"} />
                {terminalMode === "mobile" && <Field label="Usuario"><input required name="username" autoComplete="username" className={inputClass} /></Field>}
                <Field label="PIN de 6 dígitos"><input required name="pin" type="password" inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} autoComplete="one-time-code" className={`${inputClass} tracking-[0.35em]`} /></Field>
                {loginError && <p role="alert" className="text-sm text-destructive">{loginError}</p>}
                <button disabled={isLoginPending} className={primaryButton}>{isLoginPending ? "Ingresando…" : "Ingresar"}</button>
              </form>
            </TabsContent>
          ))}
        </Tabs>

        <div className="mt-6 border-t border-border pt-5">
          <h2 className="font-semibold">Autorizar dispositivo</h2>
          <p className="mt-1 text-sm text-muted-foreground">El personal necesita un dispositivo autorizado.</p>
          <button type="button" onClick={beginTerminalRequest} disabled={linkBusy || terminalPending} className="mt-3 min-h-11 w-full rounded-lg border border-input px-4 py-2 font-medium hover:bg-muted disabled:opacity-60">
            {linkBusy ? "Enviando…" : terminalPending ? "Esperando autorización…" : terminalStatus === "APPROVED" ? "Dispositivo autorizado" : "Solicitar acceso"}
          </button>
          {terminalMessage && <p role="status" className="mt-2 text-sm text-foreground">{terminalMessage}</p>}
          {terminalStatus === "APPROVED" && <button type="button" onClick={() => router.refresh()} className="mt-2 text-sm font-semibold text-primary underline underline-offset-2">Continuar</button>}
        </div>
      </section>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="grid gap-1.5 text-sm font-medium">{label}{children}</label>;
}

const inputClass = "min-h-11 w-full rounded-lg border border-input bg-card px-3 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50";
const primaryButton = "min-h-11 rounded-lg bg-primary px-4 py-2 font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60";
