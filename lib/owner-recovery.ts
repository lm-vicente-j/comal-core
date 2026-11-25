import bcrypt from "bcryptjs";
import prisma from "@/lib/prisma";

export async function recoverOwnerCredentials(existingEmail: string, newPassword: string): Promise<boolean> {
  const email = existingEmail.trim().toLowerCase();
  if (!email || newPassword.length < 12 || new TextEncoder().encode(newPassword).byteLength > 72) return false;
  const passwordHash = await bcrypt.hash(newPassword, 12);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(742910284611)`;
    const state = await tx.installationState.findUnique({ where: { id: 1 } });
    const owners = await tx.users.findMany({ where: { role: "ADMIN" }, select: { id: true, email: true } });
    if (!state?.initializedAt || owners.length !== 1 || owners[0].email?.toLowerCase() !== email) return false;
    const owner = owners[0];
    await tx.users.update({ where: { id: owner.id }, data: { password: passwordHash, active: true, credentialVersion: { increment: 1 } } });
    await tx.securityAudit.create({ data: { actorId: owner.id, action: "OWNER_CREDENTIALS_RECOVERED", subjectId: String(owner.id) } });
    return true;
  }, { isolationLevel: "Serializable" });
}
