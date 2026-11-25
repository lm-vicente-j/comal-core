import type { NextAuthConfig } from "next-auth";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { isUserRole, type AuthMode } from "@/lib/auth-types";
import { canAccessRoute } from "@/lib/permissions";
import prisma from "@/lib/prisma";
import { sha256 } from "@/lib/auth-crypto";

export const AUTH_SESSION_MAX_AGE = 8 * 60 * 60;
const TERMINAL_COOKIE = "comal_terminal";

function isAuthMode(value: unknown): value is AuthMode {
  return value === "OWNER_PASSWORD" || value === "FIXED_PIN" || value === "MOBILE_PIN";
}

export const authConfig = {
  pages: { signIn: "/login" },
  session: { strategy: "jwt", maxAge: AUTH_SESSION_MAX_AGE },
  jwt: { maxAge: AUTH_SESSION_MAX_AGE },
  callbacks: {
    authorized({ auth, request }) {
      const { pathname } = request.nextUrl;
      if (pathname === "/login") {
        return auth?.user ? NextResponse.redirect(new URL("/pos", request.nextUrl)) : true;
      }
      if (!auth?.user || !isUserRole(auth.user.role)) return false;
      return canAccessRoute(auth.user.role, pathname)
        ? true
        : NextResponse.redirect(new URL("/pos", request.nextUrl));
    },
    async jwt({ token, user }) {
      if (user) {
        token.sub = user.id;
        token.authMode = user.authMode;
        token.terminalId = user.terminalId;
        token.terminalTokenHash = user.terminalTokenHash;
        token.terminalCredentialVersion = user.terminalCredentialVersion;
        token.credentialVersion = user.credentialVersion;
        token.authenticatedAt = user.authenticatedAt || Date.now();
      }

      const userId = token.sub;
      const authMode = token.authMode as AuthMode | undefined;
      const authenticatedAt = token.authenticatedAt;
      if (!userId || !/^[1-9]\d*$/.test(userId) || !isAuthMode(authMode) || typeof authenticatedAt !== "number" || !Number.isFinite(authenticatedAt)) return null;
      if (authenticatedAt > Date.now() + 60_000 || Date.now() - authenticatedAt > AUTH_SESSION_MAX_AGE * 1000) return null;
      const id = Number(userId);
      if (!Number.isSafeInteger(id) || id > 2147483647) return null;

      try {
        const currentUser = await prisma.users.findUnique({
          where: { id },
          select: { active: true, role: true, credentialVersion: true },
        });
        if (!currentUser || currentUser.active !== true || !isUserRole(currentUser.role)) return null;
        if (currentUser.credentialVersion !== token.credentialVersion) return null;
        if (authMode === "OWNER_PASSWORD" && currentUser.role !== "ADMIN") return null;
        if (authMode !== "OWNER_PASSWORD" && currentUser.role === "ADMIN") return null;

        if (authMode !== "OWNER_PASSWORD") {
          const terminalId = token.terminalId;
          const terminalTokenHash = token.terminalTokenHash;
          if (typeof terminalId !== "string" || typeof terminalTokenHash !== "string") return null;
          const terminal = await prisma.terminal.findUnique({ where: { id: terminalId } });
          if (!terminal || !terminal.active) return null;
          if (terminal.credentialVersion !== token.terminalCredentialVersion) return null;
          if ((authMode === "FIXED_PIN" && terminal.type !== "FIXED") || (authMode === "MOBILE_PIN" && terminal.type !== "MOBILE")) return null;
          const cookieStore = await cookies();
          const terminalToken = cookieStore.get(TERMINAL_COOKIE)?.value;
          if (!terminalToken || await sha256(terminalToken) !== terminalTokenHash || terminal.tokenHash !== terminalTokenHash) return null;
        }

        token.role = currentUser.role;
        token.credentialVersion = currentUser.credentialVersion;
      } catch {
        return null;
      }
      return token;
    },
    session({ session, token }) {
      if (!session.user || !isUserRole(token.role) || typeof token.sub !== "string") return session;
      session.user.id = token.sub;
      session.user.role = token.role;
      session.user.authMode = token.authMode as AuthMode;
      session.user.terminalId = typeof token.terminalId === "string" ? token.terminalId : null;
      session.user.terminalCredentialVersion = typeof token.terminalCredentialVersion === "number" ? token.terminalCredentialVersion : undefined;
      session.user.credentialVersion = typeof token.credentialVersion === "number" ? token.credentialVersion : 0;
      session.user.authenticatedAt = typeof token.authenticatedAt === "number" ? token.authenticatedAt : 0;
      return session;
    },
  },
  providers: [],
} satisfies NextAuthConfig;
