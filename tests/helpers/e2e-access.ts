import { randomBytes, createHash, createHmac } from "node:crypto";
import type { BrowserContext } from "@playwright/test";
import { Pool } from "pg";
import { E2E_DATABASE_URL } from "../../playwright.config";
import { assertTestDatabase, testEnv } from "./test-env";

/** Browser approval is tested through the UI in 06-access; other domain specs use this fixture. */
export async function authorizeTestDevice(context: BrowserContext, type: "FIXED" | "MOBILE" = "MOBILE") {
    assertTestDatabase(E2E_DATABASE_URL);
    const token = randomBytes(32).toString("hex");
    const pool = new Pool({ connectionString: E2E_DATABASE_URL });
    try {
        const { rows } = await pool.query<{ id: string }>('INSERT INTO terminal (name, type, "tokenHash", "updatedAt") VALUES ($1, $2::"TerminalType", $3, NOW()) RETURNING id',
            ["Domain test device", type, createHash("sha256").update(token).digest("hex")]);
        await context.addCookies([{ name: "comal_terminal", value: token, domain: "localhost", path: "/", httpOnly: true, sameSite: "Strict", secure: false }]);
        return rows[0].id;
    } finally { await pool.end(); }
}

export function fixturePinHash(pin: string) {
    return createHmac("sha256", testEnv("PIN_LOOKUP_SECRET") ?? "e2e-only-pin-lookup-secret-0123456789").update(pin).digest("hex");
}
