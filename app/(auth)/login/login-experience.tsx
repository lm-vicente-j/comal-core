"use client";

import { accessMessage } from "@/lib/access-messages";
import { useActionState, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { ArrowUpRight } from "lucide-react";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { login } from "@/lib/actions/auth_action";
import { actionFail } from "@/lib/action-result";
import { createInitialOwner } from "@/lib/actions/setup";
import { getBrowserTerminalAccess, getTerminalLinkStatus, requestTerminalLink } from "@/lib/actions/terminal";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

type TerminalStatus = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";

export default function LoginExperience({ setupAvailable }: { setupAvailable: boolean }) {
  const [authorizationOpen, setAuthorizationOpen] = useState(false);
  const [pinAttempt, setPinAttempt] = useState(0);
  const [state, formAction, isLoginPending] = useActionState(submitLogin, null);
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
  const [approvedTerminalType, setApprovedTerminalType] = useState<"FIXED" | "MOBILE" | null>(null);
  const [terminalMessage, setTerminalMessage] = useState("");
  const [terminalPending, setTerminalPending] = useState(false);
  const [linkBusy, startLink] = useTransition();
  const router = useRouter();

  async function submitLogin(previousState: unknown, formData: FormData) {
    try {
      const authMode = formData.get("authMode");
      if (authMode === "FIXED_PIN" || authMode === "MOBILE_PIN") {
        try {
          const access = await getBrowserTerminalAccess();
          if (!access.success) return actionFail("Authentication service error.");
          if (!access.data.type) {
            if (terminalStatus === "APPROVED") {
              setTerminalStatus(null);
              setApprovedTerminalType(null);
              setTerminalRequestId("");
              setTerminalPending(false);
              setTerminalMessage("");
            }
            setAuthorizationOpen(true);
            return actionFail("TERMINAL_AUTHORIZATION_REQUIRED");
          }
          const expectedType = authMode === "FIXED_PIN" ? "FIXED" : "MOBILE";
          if (access.data.type !== expectedType) return actionFail("TERMINAL_TYPE_MISMATCH");
        } catch {
          return actionFail("Authentication service error.");
        }
      }
      return await login(previousState, formData);
    } finally {
      // Remount the controlled OTP after React resets the submitted form.
      setPinAttempt((attempt) => attempt + 1);
    }
  }

  useEffect(() => {
    if (!terminalRequestId || terminalStatus !== "PENDING") return;
    let live = true;
    const poll = async () => {
      let result;
      try {
        result = await getTerminalLinkStatus(terminalRequestId);
      } catch {
        if (live) setTerminalMessage("No se pudo consultar la autorización. Reintentando…");
        return;
      }
      if (!live) return;
      if (!result.success) {
        setTerminalMessage(accessMessage(result.error));
        return;
      }
      setTerminalStatus(result.data.status);
      if (result.data.status === "APPROVED") {
        setApprovedTerminalType(result.data.terminal?.type ?? null);
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
      try {
        const result = await requestTerminalLink();
        if (!result.success) {
          setTerminalMessage(accessMessage(result.error));
          return;
        }
        setTerminalRequestId(result.data.requestId);
        setTerminalStatus("PENDING");
        setTerminalPending(true);
        setTerminalMessage(`Código ${result.data.requestId.slice(0, 8).toUpperCase()}. Compártelo con el propietario y espera su autorización.`);
      } catch {
        setTerminalMessage("No se pudo enviar la solicitud. Intenta de nuevo.");
      }
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

  const loginError = state && "error" in state && state.error !== "TERMINAL_AUTHORIZATION_REQUIRED" ? accessMessage(state.error) : "";

  return (
    <main className="flex min-h-dvh flex-col items-center bg-white pt-6 font-rounded text-[#241712] sm:justify-center sm:bg-gray-100 sm:py-8">
      <section className="mx-auto w-full max-w-md bg-white px-8 pb-6 sm:rounded-xl sm:p-8">
        <div className="mb-4 flex items-center justify-center gap-3 sm:mb-6">
          <Image className="hidden sm:block" src="/icon.svg" width={42} height={42} alt="Comal Core logo" />
          <h1 className="text-center text-[clamp(1.625rem,8vw,1.875rem)] font-bold sm:text-2xl">Comal&nbsp;<span className="text-orange-500">Core</span>&nbsp; | Login</h1>
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
            <form action={formAction} className={loginFormClass}>
              <div className="grid content-start gap-4">
              <Field label="Correo"><input required type="email" name="email" placeholder="correo@ejemplo.com" autoComplete="username" className={inputClass} /></Field>
              <Field label="Contraseña"><input required type="password" name="password" placeholder="Escribe tu contraseña" autoComplete="current-password" className={inputClass} /></Field>
              </div>
              <div className="min-h-0 overflow-y-auto">{loginError && <p role="alert" className="text-sm text-destructive">{loginError}</p>}</div>
              <button disabled={isLoginPending} className={primaryButton}>{isLoginPending ? "Ingresando…" : "Ingresar"}</button>
            </form>
          </TabsContent>
          {(["fixed", "mobile"] as const).map((terminalMode) => (
            <TabsContent key={terminalMode} value={terminalMode}>
              <form action={formAction} className={loginFormClass}>
                <div className="grid content-start gap-4">
                  <input type="hidden" name="authMode" value={terminalMode === "fixed" ? "FIXED_PIN" : "MOBILE_PIN"} />
                {terminalMode === "mobile" && <Field label="Usuario"><input required name="username" placeholder="Escribe tu usuario" autoComplete="username" className={inputClass} /></Field>}
                <PersonnelPin key={`${terminalMode}-${pinAttempt}`} />
                </div>
                <div className="min-h-0 overflow-y-auto">{loginError && <p role="alert" className="text-sm text-destructive">{loginError}</p>}</div>
                <button disabled={isLoginPending} className={primaryButton}>{isLoginPending ? "Ingresando…" : "Ingresar"}</button>
              </form>
            </TabsContent>
          ))}
        </Tabs>

        <Dialog open={authorizationOpen} onOpenChange={setAuthorizationOpen}>
          <DialogTrigger asChild>
            <button type="button" className="mt-3 min-h-10 w-full text-sm text-muted-foreground underline decoration-dashed underline-offset-4 hover:text-foreground">Autorizar dispositivo</button>
          </DialogTrigger>
          <DialogContent className="flex max-h-[calc(100dvh-2rem)] max-w-sm flex-col font-rounded" showCloseButton={false}>
            <DialogHeader className="shrink-0">
              <DialogTitle>Autorizar dispositivo</DialogTitle>
              <DialogDescription role={state?.error === "TERMINAL_AUTHORIZATION_REQUIRED" && terminalStatus !== "APPROVED" ? "alert" : undefined}>El propietario debe autorizar este dispositivo para ingresar como personal.</DialogDescription>
            </DialogHeader>
            {terminalMessage && <div className="min-h-0 overflow-y-auto"><p role="status" className="break-words rounded-lg bg-muted p-3 text-sm">{terminalMessage}</p></div>}
            <DialogFooter className="shrink-0">
              <DialogClose asChild><button type="button" className="min-h-11 rounded-lg border border-input px-4 py-2 text-sm font-medium hover:bg-muted">Cerrar</button></DialogClose>
              {terminalStatus === "APPROVED" ? <button type="button" onClick={() => {
                if (approvedTerminalType) setMode(approvedTerminalType === "FIXED" ? "fixed" : "mobile");
                setAuthorizationOpen(false);
                router.refresh();
              }} className={primaryButton}>Continuar</button> : <button type="button" onClick={beginTerminalRequest} disabled={linkBusy || terminalPending} className={primaryButton}>
                {linkBusy ? "Enviando…" : terminalPending ? "Esperando autorización…" : "Solicitar acceso"}
              </button>}
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <footer className="mt-4 text-center text-xs text-muted-foreground">
          <a href="https://github.com/lm-vicente-j/comal-core" className="inline-flex min-h-10 items-center gap-1.5 px-2 py-2 font-medium hover:text-foreground focus-visible:text-foreground">
            <span>Ver repositorio en <span className="underline decoration-dashed underline-offset-4">GitHub</span></span>
            <ArrowUpRight aria-hidden="true" className="size-3.5" />
          </a>
        </footer>
      </section>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="grid gap-1.5 text-sm font-medium">{label}{children}</label>;
}

function PersonnelPin() {
  const [pin, setPin] = useState("");
  return (
    <Field label="PIN de 6 dígitos">
      <InputOTP
        name="pin"
        aria-label="PIN de 6 dígitos"
        type="password"
        required
        minLength={6}
        maxLength={6}
        pattern={REGEXP_ONLY_DIGITS}
        inputMode="numeric"
        autoComplete="one-time-code"
        containerClassName="w-full"
        value={pin}
        onChange={(value) => setPin(value.replace(/\D/g, "").slice(0, 6))}
        pasteTransformer={(value) => value.replace(/\D/g, "")}
      >
        <InputOTPGroup className="grid w-full grid-cols-6 *:h-11 *:w-full">
          {Array.from({ length: 6 }, (_, index) => <InputOTPSlot key={index} index={index} mask />)}
        </InputOTPGroup>
      </InputOTP>
    </Field>
  );
}

const inputClass = "min-h-11 w-full rounded-lg border border-gray-300 bg-white px-4 py-2 text-base outline-none focus-visible:border-orange-500 focus-visible:ring-2 focus-visible:ring-orange-500/30";
const loginFormClass = "mt-5 grid h-[17rem] grid-rows-[1fr_2.5rem_2.75rem] gap-4";
const primaryButton = "min-h-11 w-full cursor-pointer rounded-lg bg-orange-500 px-4 py-2 font-semibold text-white transition-colors hover:bg-orange-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-500 disabled:cursor-not-allowed disabled:opacity-60";
