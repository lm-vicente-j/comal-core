"use client"
import { useActionState } from "react";

import { login } from "@/lib/actions/auth_action";
import Image from "next/image";
import { ArrowUpRight, Loader2 } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"


import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp"
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { useState } from "react";
import { FieldError } from "@/components/ui/field";

export default function LoginPage() {
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const [state, formAction, isPending] = useActionState(login, null);
  const serverPinError =
    state && "fieldErrors" in state ? state.fieldErrors?.pin?.[0] : undefined;
  const displayPinError = pinError ?? serverPinError;



  return (
    <div className="min-h-dvh flex flex-col items-center bg-white pt-[clamp(0.75rem,calc(18dvh_-_5rem),4rem)] font-rounded text-[#241712] sm:justify-center sm:bg-gray-100 sm:pt-0">

      <Tabs
        defaultValue="admin"
        onValueChange={() => setPinError(null)}
        className="bg-white px-8 pb-6 rounded-xl w-full max-w-md sm:p-8"
      >
        <div className="flex flex-row items-center justify-center mb-1 sm:my-2">
          <Image className="hidden sm:block" src="/icon.svg" width={50} height={50} alt="Comal Core logo" />
          <h1 className="flex justify-center items-center text-[clamp(1.625rem,8vw,1.875rem)] font-bold text-center mb-3 sm:m-6 sm:text-2xl">Comal&nbsp;<span className="text-orange-500">Core</span>&nbsp; | Login</h1>

        </div>
        <TabsList className="max-sm:self-center">
          <TabsTrigger value="admin" className="cursor-pointer">Administrador</TabsTrigger>
          <TabsTrigger value="staff" className="cursor-pointer">Staff</TabsTrigger>
        </TabsList>
        <TabsContent value="admin">


          <form action={formAction} className="space-y-4 py-6 min-h-60">
            <FieldError errors={[{ message: state?.error }]} />

            <div>
              <label className="block text-sm font-medium text-gray-700">Email</label>
              <input
                name="email"
                type="email"
                placeholder="correo@ejemplo.com"
                required
                className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-orange-500 outline-none"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">Contraseña</label>
              <input
                name="password"
                type="password"
                placeholder="Escribe tu contraseña"
                required
                className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-orange-500 outline-none"
              />
            </div>
            <button
              type="submit"
              disabled={isPending}
              className="mt-5 w-full cursor-pointer bg-orange-500 hover:bg-orange-600 text-white font-semibold py-2 rounded-lg transition-colors flex items-center justify-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed"
            >
              {isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Iniciando sesión...
                </>
              ) : (
                "Entrar al Sistema"
              )}
            </button>
          </form>

        </TabsContent>
        <TabsContent value="staff">


          <form
            action={formAction}
            onSubmit={(e) => {
              if (!/^\d{4}$/.test(pin)) {
                e.preventDefault();
                setPinError("El PIN debe tener 4 dígitos");
                return;
              }
              setPinError(null);
            }}
            className="space-y-4 py-6 min-h-60"
          >
            <FieldError errors={[{ message: state?.error }]} />

            <div className="flex gap-2 flex-col flex-1 items-center justify-center max-sm:items-stretch max-sm:gap-4">
              <div className="flex flex-1 flex-row items-center gap-3 justify-center max-sm:flex-col max-sm:items-stretch max-sm:gap-0">
                <label htmlFor="staff-username" className="block text-sm font-medium text-gray-700">Usuario</label>
                <input required
                  id="staff-username"
                  placeholder="Escribe tu usuario"
                  className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-orange-500 outline-none"
                  name="username" />


              </div>

              <div className="flex flex-1 flex-col items-center justify-center gap-1 max-sm:items-stretch">
                <div className="flex flex-row items-center gap-3 justify-center max-sm:flex-col max-sm:items-stretch max-sm:gap-0">
                  <label htmlFor="staff-pin" className="text-sm font-medium text-gray-700">PIN</label>
                  <input type="hidden" name="pin" value={pin} />
                  <InputOTP
                    id="staff-pin"
                    aria-label="PIN"
                    type="password"
                    maxLength={4}
                    placeholder="––––"
                    pattern={REGEXP_ONLY_DIGITS}
                    inputMode="numeric"
                    autoComplete="off"
                    pasteTransformer={(pasted) => {
                      const digits = pasted.replace(/\D/g, "");
                      return digits.length > 0 ? digits : pasted;
                    }}
                    value={pin}
                    onChange={(v) => {
                      const digits = v.replace(/\D/g, "").slice(0, 4);
                      setPin(digits);
                      setPinError(null);
                    }}
                  >
                    <InputOTPGroup className="max-sm:grid max-sm:w-full max-sm:grid-cols-4 max-sm:*:h-[2.625rem] max-sm:*:w-full">
                      <InputOTPSlot index={0} mask aria-invalid={!!displayPinError || undefined} />
                      <InputOTPSlot index={1} mask aria-invalid={!!displayPinError || undefined} />
                      <InputOTPSlot index={2} mask aria-invalid={!!displayPinError || undefined} />
                      <InputOTPSlot index={3} mask aria-invalid={!!displayPinError || undefined} />
                    </InputOTPGroup>
                  </InputOTP>
                </div>
                {displayPinError && (
                  <p role="alert" className="text-destructive text-xs">
                    {displayPinError}
                  </p>
                )}
              </div>
            </div>
            <button
              type="submit"
              disabled={isPending}
              className="mt-5 w-full cursor-pointer bg-orange-500 hover:bg-orange-600 text-white font-semibold py-2 rounded-lg transition-colors flex items-center justify-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed"
            >
              {isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Iniciando sesión...
                </>
              ) : (
                "Entrar al Sistema"
              )}
            </button>
          </form>
        </TabsContent>
        <footer className="flex flex-col items-center text-center text-xs text-muted-foreground">
          <a
            href="https://github.com/lm-vicente-j/comal-core"
            className="inline-flex items-center gap-1.5 px-2 py-2 font-medium hover:text-foreground focus-visible:text-foreground"
          >
            <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor" className="size-4">
              <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38l-.01-1.49c-2.01.43-2.53-.49-2.69-.97-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
            <span>Ver repositorio en <span className="underline decoration-dashed underline-offset-4">GitHub</span></span>
            <ArrowUpRight aria-hidden="true" className="size-3.5" />
          </a>
        </footer>
      </Tabs>

    </div>
  )
}
