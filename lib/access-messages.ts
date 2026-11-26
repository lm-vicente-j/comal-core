/** Short UI messages; server action codes remain stable across languages. */
const messages: Record<string, string> = {
  INVALID_INPUT: "Revisa los datos.",
  INVALID_INSTALLATION_SECRET: "La clave de instalación es incorrecta.",
  PASSWORDS_DO_NOT_MATCH: "Las contraseñas no coinciden.",
  PASSWORD_TOO_LONG: "La contraseña es demasiado larga.",
  SETUP_UNAVAILABLE: "El alta inicial no está disponible.",
  FORBIDDEN: "No tienes permiso para esta acción.",
  Forbidden: "No tienes permiso para esta acción.",
  "Invalid credentials": "Revisa tus datos de acceso.",
  "Incorrect credentials or unauthorized terminal.": "Datos incorrectos o dispositivo sin autorización.",
  "Too many failed attempts. Try again later.": "Demasiados intentos. Espera 15 minutos.",
  "Too many terminal requests; try again later": "Demasiadas solicitudes. Espera 15 minutos.",
  "Authentication service error.": "No se pudo iniciar sesión. Intenta de nuevo.",
  TERMINAL_AUTHORIZATION_REQUIRED: "Autoriza este dispositivo para ingresar como personal.",
  TERMINAL_TYPE_MISMATCH: "El tipo de acceso no corresponde al dispositivo autorizado. Cambia entre Fijo y Móvil.",
  "This browser is already authorized": "Este dispositivo ya está autorizado. Usa el tipo de acceso correspondiente.",
  "Email already registered": "Ese correo ya está registrado.",
  "Request is no longer pending": "La solicitud venció o ya fue atendida.",
  "Permission cannot be changed": "Ese permiso está reservado al propietario.",
  "No changes provided": "No hay cambios para guardar.",
  "Staff account not found or protected": "No se puede modificar esta cuenta.",
  "Staff account not found": "No se encontró la cuenta.",
};

export function accessMessage(error: string): string {
  return messages[error] ?? "No se pudo completar la acción. Intenta de nuevo.";
}
