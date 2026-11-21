type DatabaseEnvironment = Readonly<Record<string, string | undefined>>;

export function databaseUrl(env: DatabaseEnvironment = process.env) {
    return env.VERCEL_ENV === "preview" ? env.PREVIEW_DATABASE_URL : env.DATABASE_URL;
}

export function migrationDatabaseUrl(env: DatabaseEnvironment = process.env) {
    return env.VERCEL_ENV === "preview"
        ? env.PREVIEW_DIRECT_URL ?? env.PREVIEW_DATABASE_URL
        : env.DIRECT_URL ?? env.DATABASE_URL;
}
