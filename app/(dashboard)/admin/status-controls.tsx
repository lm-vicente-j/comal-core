"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog"

export function StatusFilter({ value, onChange }: { value: string; onChange: (value: string) => void }) {
    return <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label="Filtrar por estado" className="w-full sm:w-[180px]"><SelectValue /></SelectTrigger>
        <SelectContent>
            <SelectItem value="active">Activos</SelectItem>
            <SelectItem value="inactive">Inactivos</SelectItem>
            <SelectItem value="all">Todos los estados</SelectItem>
        </SelectContent>
    </Select>
}

export function StatusChange({ name, active, kind, action, onSuccess, focusTarget, disabled }: {
    name: string; active: boolean; kind: "insumo" | "producto";
    action: (active: boolean) => Promise<{ success: boolean; error?: string }>;
    onSuccess: () => void; focusTarget: React.RefObject<HTMLInputElement | null>; disabled?: boolean;
}) {
    const [open, setOpen] = React.useState(false)
    const [pending, setPending] = React.useState(false)
    const successRef = React.useRef(false)
    const [error, setError] = React.useState<string | null>(null)
    const verb = active ? "Desactivar" : "Reactivar"
    const submit = async () => {
        if (pending) return
        setPending(true)
        setError(null)
        try {
            const result = await action(!active)
            if (result.success) { successRef.current = true; setOpen(false); focusTarget.current?.focus(); onSuccess() }
            else setError(result.error || "No se pudo cambiar el estado.")
        } catch { setError("Error de conexión al cambiar el estado.") }
        finally { setPending(false) }
    }
    return <AlertDialog open={open} onOpenChange={next => { if (!pending) { setOpen(next); setError(null) } }}>
        <AlertDialogTrigger asChild><Button type="button" variant="outline" size="sm" disabled={disabled} aria-label={`${verb} ${name}`}>{verb}</Button></AlertDialogTrigger>
        <AlertDialogContent onCloseAutoFocus={event => { if (successRef.current) { event.preventDefault(); focusTarget.current?.focus(); successRef.current = false } }}>
            <AlertDialogHeader>
                <AlertDialogTitle>¿{verb} {kind}?</AlertDialogTitle>
                <AlertDialogDescription>
                    {active
                        ? kind === "insumo"
                            ? `Al desactivar ${name}, no podrá agregarse a recetas y los productos que lo contienen no podrán venderse. Las recetas y el historial se conservarán.`
                            : `Al desactivar ${name}, dejará de estar disponible para ventas. Su receta y el historial se conservarán.`
                        : kind === "insumo"
                            ? `Al reactivar ${name}, podrá volver a usarse en recetas y ventas, siempre que los demás insumos y productos estén activos.`
                            : `Al reactivar ${name}, podrá volver a venderse si todos sus insumos están activos.`}
                </AlertDialogDescription>
            </AlertDialogHeader>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <AlertDialogFooter>
                <AlertDialogCancel disabled={pending}>Cancelar</AlertDialogCancel>
                <Button type="button" disabled={pending} onClick={submit}>{pending ? "Guardando…" : verb}</Button>
            </AlertDialogFooter>
        </AlertDialogContent>
    </AlertDialog>
}
