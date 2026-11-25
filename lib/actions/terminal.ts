"use server";

import { randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { actionFail, actionOk, type ActionResult } from "@/lib/action-result";
import { sha256 } from "@/lib/auth-crypto";
import { persistentRateLimitStatus, recordPersistentFailedAttempt } from "@/lib/auth-lockout";

const REQUEST_COOKIE = "comal_terminal_request";
const TERMINAL_COOKIE = "comal_terminal";
const REQUEST_TTL_MS = 10 * 60 * 1000;
const secureCookies = process.env.NODE_ENV === "production";
const terminalTypeSchema = z.enum(["FIXED", "MOBILE"]);

async function requireOwner(): Promise<number | null> {
  const session = await auth();
  if (session?.user?.role !== "ADMIN" || !session.user.id) return null;
  const id = Number(session.user.id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const current = await prisma.users.findUnique({ where: { id }, select: { role: true, active: true } });
  return current?.role === "ADMIN" && current.active !== false ? id : null;
}

export interface TerminalSummary {
  id: string;
  name: string;
  type: "FIXED" | "MOBILE";
  active: boolean;
  createdAt: string;
}

export interface TerminalRequestSummary {
  id: string;
  createdAt: string;
  expiresAt: string;
}

export async function requestTerminalLink(): Promise<ActionResult<{ requestId: string; expiresAt: string }>> {
  try {
    const cookieStore = await cookies();
    const existingTerminalToken = cookieStore.get(TERMINAL_COOKIE)?.value;
    if (existingTerminalToken) {
      const terminal = await prisma.terminal.findFirst({ where: { tokenHash: await sha256(existingTerminalToken), active: true }, select: { id: true } });
      if (terminal) return actionFail("This browser is already authorized");
    }
    let token = cookieStore.get(REQUEST_COOKIE)?.value;
    if (token && /^[a-f0-9]{64}$/.test(token)) {
      const pending = await prisma.terminalRequest.findFirst({
        where: { browserTokenHash: await sha256(token), status: "PENDING", expiresAt: { gt: new Date() } },
        select: { id: true, expiresAt: true },
      });
      if (pending) return actionOk({ requestId: pending.id, expiresAt: pending.expiresAt.toISOString() });
    }
    token = randomBytes(32).toString("hex");
    const tokenHash = await sha256(token);
    const requestHeaders = await headers();
    const ip = requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const rateKey = `terminal-request:${await sha256(ip)}`;
    if ((await persistentRateLimitStatus(rateKey)).blocked) return actionFail("Too many terminal requests; try again later");
    const rate = await recordPersistentFailedAttempt(rateKey);
    if ((rate?.attempts ?? 0) >= 5) return actionFail("Too many terminal requests; try again later");
    const now = new Date();
    const linkRequest = await prisma.terminalRequest.create({
      data: { browserTokenHash: tokenHash, expiresAt: new Date(now.getTime() + REQUEST_TTL_MS) },
      select: { id: true, expiresAt: true },
    });
    cookieStore.set(REQUEST_COOKIE, token, {
      httpOnly: true, secure: secureCookies, sameSite: "strict", path: "/", maxAge: Math.ceil(REQUEST_TTL_MS / 1000),
    });
    return actionOk({ requestId: linkRequest.id, expiresAt: linkRequest.expiresAt.toISOString() });
  } catch {
    return actionFail("Could not request terminal authorization");
  }
}

export async function getTerminalLinkStatus(requestId: string): Promise<ActionResult<{
  status: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";
  terminal?: { id: string; name: string; type: "FIXED" | "MOBILE" };
  expiresAt: string;
}>> {
  if (typeof requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(requestId)) return actionFail("Invalid request");
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get(REQUEST_COOKIE)?.value;
    if (!token) return actionFail("Browser authorization request is missing");
    const tokenHash = await sha256(token);
    const request = await prisma.terminalRequest.findFirst({
      where: { id: requestId, browserTokenHash: tokenHash },
      include: { terminal: { select: { id: true, name: true, type: true, active: true, tokenHash: true } } },
    });
    if (!request) return actionFail("Authorization request not found");
    let status = request.status;
    if ((status === "PENDING" || status === "APPROVED") && request.expiresAt <= new Date()) {
      // Expiry closes the linking request; only an explicit owner action may
      // revoke a browser which has already received its authorization cookie.
      await prisma.terminalRequest.updateMany({ where: { id: request.id, status }, data: { status: "EXPIRED" } });
      status = "EXPIRED";
    }
    if (status === "APPROVED" && request.expiresAt > new Date() && request.terminal?.active && request.terminal.tokenHash === tokenHash) {
      cookieStore.set(TERMINAL_COOKIE, token, {
        httpOnly: true, secure: secureCookies, sameSite: "strict", path: "/", maxAge: 365 * 24 * 60 * 60,
      });
      cookieStore.delete(REQUEST_COOKIE);
      return actionOk({ status, terminal: { id: request.terminal.id, name: request.terminal.name, type: request.terminal.type }, expiresAt: request.expiresAt.toISOString() });
    }
    return actionOk({ status, expiresAt: request.expiresAt.toISOString() });
  } catch {
    return actionFail("Could not read terminal authorization status");
  }
}

export async function listTerminalRequests(): Promise<ActionResult<TerminalRequestSummary[]>> {
  if (await requireOwner() === null) return actionFail("Forbidden");
  try {
    await prisma.terminalRequest.updateMany({ where: { status: "PENDING", expiresAt: { lte: new Date() } }, data: { status: "EXPIRED" } });
    const rows = await prisma.terminalRequest.findMany({
      where: { status: "PENDING" }, orderBy: { createdAt: "desc" }, take: 100,
      select: { id: true, createdAt: true, expiresAt: true },
    });
    return actionOk(rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString() })));
  } catch {
    return actionFail("Could not load terminal requests");
  }
}

export async function approveTerminalRequest(requestId: string, name: string, type: "FIXED" | "MOBILE"): Promise<ActionResult> {
  const actorId = await requireOwner();
  if (actorId === null) return actionFail("Forbidden");
  const parsed = z.object({ requestId: z.string().uuid(), name: z.string().trim().min(1).max(80), type: terminalTypeSchema }).safeParse({ requestId, name, type });
  if (!parsed.success) return actionFail("Invalid terminal request");
  try {
    const approved = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "terminalRequest" WHERE id = ${parsed.data.requestId}::uuid FOR UPDATE`;
      const request = await tx.terminalRequest.findUnique({ where: { id: parsed.data.requestId } });
      if (!request || request.status !== "PENDING" || request.expiresAt <= new Date()) return false;
      const terminal = await tx.terminal.create({ data: { name: parsed.data.name, type: parsed.data.type, tokenHash: request.browserTokenHash } });
      await tx.terminalRequest.update({ where: { id: request.id }, data: { status: "APPROVED", terminalId: terminal.id } });
      await tx.securityAudit.create({ data: { actorId, action: "TERMINAL_APPROVED", subjectId: terminal.id, metadata: { type: terminal.type, name: terminal.name } } });
      return true;
    });
    return approved ? actionOk() : actionFail("Request is no longer pending");
  } catch {
    return actionFail("Could not approve terminal request");
  }
}

export async function listTerminals(): Promise<ActionResult<TerminalSummary[]>> {
  if (await requireOwner() === null) return actionFail("Forbidden");
  try {
    const rows = await prisma.terminal.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }], select: { id: true, name: true, type: true, active: true, createdAt: true } });
    return actionOk(rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })));
  } catch {
    return actionFail("Could not load terminals");
  }
}

export async function updateTerminal(id: string, data: { name?: string; type?: "FIXED" | "MOBILE" }): Promise<ActionResult> {
  const actorId = await requireOwner();
  if (actorId === null) return actionFail("Forbidden");
  const parsed = z.object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(80).optional(),
    type: terminalTypeSchema.optional(),
  }).strict().safeParse({ id, ...(data && typeof data === "object" ? data : {}) });
  if (!parsed.success || (!parsed.data.name && !parsed.data.type)) return actionFail("Invalid terminal update");
  try {
    await prisma.$transaction(async (tx) => {
      const current = await tx.terminal.findUnique({ where: { id }, select: { name: true, type: true, credentialVersion: true } });
      if (!current) throw new Error("TERMINAL_NOT_FOUND");
      const typeChanged = parsed.data.type !== undefined && current.type !== parsed.data.type;
      const dataChanged = (parsed.data.name !== undefined && current.name !== parsed.data.name) || (parsed.data.type !== undefined && current.type !== parsed.data.type);
      await tx.terminal.update({ where: { id }, data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.type !== undefined ? { type: parsed.data.type } : {}),
        ...(typeChanged ? { credentialVersion: { increment: 1 } } : {}),
      } });
      if (dataChanged) await tx.securityAudit.create({ data: { actorId, action: "TERMINAL_UPDATED", subjectId: id, metadata: { name: parsed.data.name ?? current.name, type: parsed.data.type ?? current.type } } });
    });
    return actionOk();
  } catch {
    return actionFail("Could not update terminal");
  }
}

export async function revokeTerminal(id: string): Promise<ActionResult> {
  const actorId = await requireOwner();
  if (actorId === null) return actionFail("Forbidden");
  if (!z.string().uuid().safeParse(id).success) return actionFail("Invalid terminal");
  try {
    await prisma.$transaction(async (tx) => {
      const terminal = await tx.terminal.update({ where: { id }, data: { active: false, credentialVersion: { increment: 1 } }, select: { id: true } });
      await tx.terminalRequest.updateMany({ where: { terminalId: id, status: "APPROVED" }, data: { status: "REJECTED" } });
      await tx.securityAudit.create({ data: { actorId, action: "TERMINAL_REVOKED", subjectId: terminal.id } });
    });
    return actionOk();
  } catch {
    return actionFail("Could not revoke terminal");
  }
}
