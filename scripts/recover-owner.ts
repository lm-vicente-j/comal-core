import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import prisma from "../lib/prisma";
import { recoverOwnerCredentials } from "../lib/owner-recovery";

function readMaskedPassword(label: string): Promise<string> {
  if (!input.isTTY) {
    const reader = createInterface({ input, output });
    return reader.question(`${label}: `).finally(() => reader.close());
  }
  return new Promise((resolve, reject) => {
    output.write(`${label}: `);
    let value = "";
    input.setRawMode(true);
    input.resume();
    const finish = (error?: Error) => {
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
      output.write("\n");
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003") return finish(new Error("Cancelled"));
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    input.on("data", onData);
  });
}

async function main() {
  const terminal = createInterface({ input, output });
  try {
    const email = (await terminal.question("Existing owner email: ")).trim().toLowerCase();
    terminal.close();
    const password = await readMaskedPassword("New owner password (minimum 12 characters)");
    const confirmation = await readMaskedPassword("Confirm new owner password");
    if (password !== confirmation) throw new Error("Passwords do not match");
    const changed = await recoverOwnerCredentials(email, password);
    if (!changed) throw new Error("The installation or owner record is not in a recoverable state");
    output.write("Owner credentials reset. Existing sessions have been invalidated.\n");
  } finally {
    terminal.close();
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  output.write(`${error instanceof Error ? error.message : "Owner recovery failed"}\n`);
  process.exitCode = 1;
});
