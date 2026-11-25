import type { DefaultSession } from "next-auth";

import type { AuthMode, UserRole } from "@/lib/auth-types";

declare module "next-auth" {
  interface Session {
    user: {
      id: string | undefined;
      role: UserRole;
      authMode: AuthMode;
      terminalId: string | null;
      terminalCredentialVersion?: number;
      credentialVersion: number;
      authenticatedAt: number;
    } & DefaultSession["user"];
  }

  interface User {
    role: UserRole;
    authMode: AuthMode;
    terminalId: string | null;
    terminalTokenHash?: string | null;
    terminalCredentialVersion?: number;
    credentialVersion: number;
    authenticatedAt: number;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    // Kept optional while JWTs issued before this change expire.
    id?: string;
    role?: UserRole;
    authMode?: AuthMode;
    terminalId?: string | null;
    terminalTokenHash?: string | null;
    terminalCredentialVersion?: number;
    credentialVersion?: number;
    authenticatedAt?: number;
  }
}
