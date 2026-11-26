import { spawnSync } from "node:child_process";

const result = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "tests/property", "tests/fuzz", ...process.argv.slice(2)], {
    env: { ...process.env, FC_PROFILE: "stress" },
    stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
