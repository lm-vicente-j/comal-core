import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { databaseUrl, migrationDatabaseUrl } from "@/lib/database-env";

describe("database and seed environment guards", () => {
    it("refuses to run demo seed when NODE_ENV is production", () => {
        try {
            execFileSync(process.execPath, ["--import", "tsx", "prisma/seed.ts"], {
                env: { ...process.env, NODE_ENV: "production" },
                stdio: "pipe",
            });
            expect.fail("Expected seed to fail in production environment");
        } catch (e: unknown) {
            const err = e as { status?: number; stderr?: Buffer | string };
            expect(err.status).toBe(1);
            expect(err.stderr?.toString()).toContain("Refusing to run demo seed in production environment!");
        }
    });

    it("does not use production database variables in a preview", () => {
        const env = {
            VERCEL_ENV: "preview",
            DATABASE_URL: "postgresql://prod.example/comal",
            DIRECT_URL: "postgresql://prod-direct.example/comal",
        };
        expect(databaseUrl(env)).toBeUndefined();
        expect(migrationDatabaseUrl(env)).toBeUndefined();

        const preview = {
            ...env,
            PREVIEW_DATABASE_URL: "postgresql://preview.example/comal",
            PREVIEW_DIRECT_URL: "postgresql://preview-direct.example/comal",
        };
        expect(databaseUrl(preview)).toBe(preview.PREVIEW_DATABASE_URL);
        expect(migrationDatabaseUrl(preview)).toBe(preview.PREVIEW_DIRECT_URL);
        expect(migrationDatabaseUrl({ ...preview, PREVIEW_DIRECT_URL: undefined })).toBe(preview.PREVIEW_DATABASE_URL);
        expect(databaseUrl({ ...preview, VERCEL_ENV: "production" })).toBe(env.DATABASE_URL);
        expect(migrationDatabaseUrl({ ...preview, VERCEL_ENV: "production" })).toBe(env.DIRECT_URL);
    });

    it("refuses to seed a preview without its preview database variable", () => {
        expect(() => execFileSync(process.execPath, ["--import", "tsx", "prisma/seed.ts"], {
            env: {
                ...process.env,
                NODE_ENV: "development",
                VERCEL_ENV: "preview",
                DATABASE_URL: "postgresql://unused.example/comal",
                PREVIEW_DATABASE_URL: "",
            },
            stdio: "pipe",
        })).toThrow("PREVIEW_DATABASE_URL is required to seed a Vercel preview.");
    });

});
