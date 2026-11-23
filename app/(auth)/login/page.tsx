"use client"
import { useActionState } from "react";

import { login } from "@/lib/actions/auth_action";
import Image from "next/image";
import { Loader2 } from "lucide-react";
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
    <div className="min-h-screen flex items-center justify-center bg-white font-rounded text-[#241712] sm:bg-gray-100">

      <Tabs
        defaultValue="admin"
        onValueChange={() => setPinError(null)}
        className="bg-white p-8 rounded-xl w-full max-w-md"
      >
        <div className="flex flex-row items-center justify-center my-2 ">
          <Image className="hidden sm:block" src="/icon.svg" width={50} height={50} alt="Comal Core logo" />
          <h1 className="flex justify-center items-center text-[clamp(1.625rem,8vw,1.875rem)] font-bold text-center my-6 sm:m-6 sm:text-2xl">Comal&nbsp;<span className="text-orange-500">Core</span>&nbsp; | Login</h1>

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
      </Tabs>

    </div>
  )
}
