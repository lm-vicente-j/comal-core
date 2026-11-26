import { beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

vi.mock("@/lib/auth", async () => ({
  auth: (await import("./helpers")).authMock,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { createPinLookupHash } from "@/lib/auth-crypto";
import {
  getCashHandoverContext,
  recordCashHandover,
  getCashCountHistory,
  exportCashCountHistory,
  getJornadaClosingSummary,
  openJornada,
  closeJornada,
  recordCashCount,
} from "@/lib/actions/jornada";
import { saveExpense } from "@/lib/actions/expenses";
import { getJornadaCashSummary } from "@/lib/jornada-cash";
import { acquireJornadaTicketLock } from "@/lib/ticket-reservations";
import { loginAs, logout, makeCashCountInput, resetDb } from "./helpers";

const PIN = "123456";
const OTHER_PIN = "654321";
let owner: number, incoming: number, next: number, jornada: number;

beforeEach(async () => {
  await resetDb();
  owner = (
    await prisma.users.create({
      data: { name: "Outgoing", role: "ADMIN", active: true },
    })
  ).id;
  incoming = (
    await prisma.users.create({
      data: {
        name: "Incoming",
        role: "STAFF",
        active: true,
        pin: await bcrypt.hash(PIN, 4),
        pinLookupHash: createPinLookupHash(PIN),
      },
    })
  ).id;
  next = (
    await prisma.users.create({
      data: {
        name: "Next",
        role: "SUPERVISOR",
        active: true,
        pin: await bcrypt.hash(OTHER_PIN, 4),
        pinLookupHash: createPinLookupHash(OTHER_PIN),
      },
    })
  ).id;
  loginAs("ADMIN", owner);
  const opened = await openJornada(makeCashCountInput(50000));
  if (!opened.success) throw new Error(opened.error);
  jornada = opened.data.jornadaId;
});

describe("cash handovers", () => {
  it("freezes both participant names across later personnel edits and request retries", async () => {
    const input = makeCashCountInput(50000);
    const first = await recordCashHandover(jornada, input, incoming, PIN);
    expect(first.success).toBe(true);
    await prisma.users.update({
      where: { id: owner },
      data: { name: "Renamed outgoing" },
    });
    await prisma.users.update({
      where: { id: incoming },
      data: { name: "Renamed incoming" },
    });
    expect(await recordCashHandover(jornada, input, incoming, PIN)).toEqual(
      first,
    );
    expect(await getCashCountHistory({ type: "HANDOVER" })).toMatchObject({
      success: true,
      data: {
        items: [{ operatorName: "Outgoing", incomingOperatorName: "Incoming" }],
      },
    });
    expect(await getJornadaClosingSummary(jornada)).toMatchObject({
      success: true,
      data: {
        counts: expect.arrayContaining([
          expect.objectContaining({
            type: "HANDOVER",
            operatorName: "Outgoing",
            incomingOperatorName: "Incoming",
          }),
        ]),
      },
    });
    const csv = await exportCashCountHistory({ type: "HANDOVER" });
    expect(csv.success && csv.data).toContain('"Outgoing"');
    expect(csv.success && csv.data).not.toContain("Renamed");
  });

  it("records an immutable receipt attributed to the outgoing operator and confirmed by the incoming operator", async () => {
    const result = await recordCashHandover(
      jornada,
      makeCashCountInput(49000, "Shortage counted together"),
      incoming,
      PIN,
    );
    expect(result).toMatchObject({
      success: true,
      data: {
        type: "HANDOVER",
        operatorId: owner,
        incomingOperatorId: incoming,
        incomingOperatorName: "Incoming",
        countedAmount: 49000,
        expectedAmount: 50000,
        difference: -1000,
      },
    });
    if (!result.success) throw new Error(result.error);
    await expect(
      prisma.cash_count.update({
        where: { id: result.data.id },
        data: { incomingOperatorId: next },
      }),
    ).rejects.toThrow(/CASH_COUNT_IMMUTABLE/);
    await expect(
      prisma.cash_count.delete({ where: { id: result.data.id } }),
    ).rejects.toThrow(/CASH_COUNT_IMMUTABLE/);
    const stored = await prisma.cash_count.findUniqueOrThrow({
      where: { id: result.data.id },
    });
    expect(
      JSON.stringify(stored, (_, v) =>
        typeof v === "bigint" ? v.toString() : v,
      ),
    ).not.toContain(PIN);
    expect(
      (await prisma.jornada.findUniqueOrThrow({ where: { id: jornada } }))
        .status,
    ).toBe("OPEN");
    loginAs("STAFF", incoming);
    expect(await getCashHandoverContext(jornada)).toMatchObject({
      operatorId: incoming,
      canDeliver: true,
    });
  });

  it("starts the next operator from the accepted cash without charging the earlier shortage again", async () => {
    expect(
      await recordCashHandover(
        jornada,
        makeCashCountInput(49000, "First shortage"),
        incoming,
        PIN,
      ),
    ).toMatchObject({ success: true });
    loginAs("STAFF", incoming);
    expect(
      await saveExpense({
        amount: 1000,
        category: "Other",
        description: "Cash after handover",
        date: new Date(),
        payment_method: "CASH",
      }),
    ).toMatchObject({ success: true });
    expect(
      await recordCashHandover(
        jornada,
        makeCashCountInput(48000),
        next,
        OTHER_PIN,
      ),
    ).toMatchObject({
      success: true,
      data: { operatorId: incoming, countedAmount: 48000 },
    });
    const rows = await prisma.cash_count.findMany({
      where: { type: "HANDOVER" },
      orderBy: { id: "asc" },
    });
    expect(rows.map((r) => Number(r.differenceCents))).toEqual([-1000, 0]);
    loginAs("SUPERVISOR", next);
    expect(
      await closeJornada(jornada, makeCashCountInput(48000)),
    ).toMatchObject({
      success: true,
      data: { expectedAmount: 48000, difference: 0 },
    });
  });

  it("also carries accepted surpluses forward", async () => {
    expect(
      await recordCashHandover(
        jornada,
        makeCashCountInput(51000, "Surplus"),
        incoming,
        PIN,
      ),
    ).toMatchObject({ success: true, data: { difference: 1000 } });
    expect(await getJornadaCashSummary(jornada, 50000)).toMatchObject({
      expectedCash: 51000,
    });
  });

  it("requires a note outside the frozen tolerance and never changes custody on a rejected count", async () => {
    expect(
      await recordCashHandover(
        jornada,
        makeCashCountInput(49000),
        incoming,
        PIN,
      ),
    ).toMatchObject({ success: false, error: "NOTE_REQUIRED" });
    expect(await getCashHandoverContext(jornada)).toMatchObject({
      operatorId: owner,
      canDeliver: true,
    });
    expect(await prisma.cash_count.count({ where: { type: "HANDOVER" } })).toBe(
      0,
    );
    await prisma.setting.create({
      data: { key: "CASH_COUNT_TOLERANCE_CENTS", value: "1000" },
    });
    expect(
      await recordCashHandover(
        jornada,
        makeCashCountInput(49000),
        incoming,
        PIN,
      ),
    ).toMatchObject({
      success: true,
      data: { tolerance: 1000, result: "BALANCED" },
    });
  });

  it("rejects wrong PINs and locks the incoming account after five failed attempts", async () => {
    const input = makeCashCountInput(50000);
    for (let i = 0; i < 5; i++)
      expect(
        await recordCashHandover(jornada, input, incoming, "000000"),
      ).toMatchObject({ success: false, error: "INVALID_HANDOVER_PIN" });
    expect(
      await recordCashHandover(jornada, input, incoming, PIN),
    ).toMatchObject({ success: false, error: "HANDOVER_PIN_LOCKED" });
    expect(await getCashHandoverContext(jornada)).toMatchObject({
      operatorId: owner,
    });
    expect(await prisma.cash_count.count({ where: { type: "HANDOVER" } })).toBe(
      0,
    );
  });

  it("does not accept another operator's PIN", async () => {
    expect(
      await recordCashHandover(
        jornada,
        makeCashCountInput(50000),
        incoming,
        OTHER_PIN,
      ),
    ).toMatchObject({ success: false, error: "INVALID_HANDOVER_PIN" });
  });

  it("rejects inactive, missing, owner and PIN-less incoming operators", async () => {
    for (const data of [
      { active: false },
      { role: "UNKNOWN" },
      { pin: null },
      { pinLookupHash: null },
    ]) {
      const previous = await prisma.users.findUniqueOrThrow({
        where: { id: incoming },
      });
      await prisma.users.update({ where: { id: incoming }, data });
      expect(
        await recordCashHandover(
          jornada,
          makeCashCountInput(50000),
          incoming,
          PIN,
        ),
      ).toMatchObject({ success: false, error: "INVALID_HANDOVER_PIN" });
      await prisma.users.update({
        where: { id: incoming },
        data: {
          active: previous.active,
          role: previous.role,
          pin: previous.pin,
          pinLookupHash: previous.pinLookupHash,
        },
      });
    }
    expect(
      await recordCashHandover(
        jornada,
        makeCashCountInput(50000),
        2147483647,
        PIN,
      ),
    ).toMatchObject({ success: false });
  });

  it("validates identifiers, the PIN shape, self-handover and count inputs", async () => {
    for (const id of [0, -1, 1.5, NaN, 2147483648, "1", null]) {
      expect(
        await recordCashHandover(
          id as number,
          makeCashCountInput(50000),
          incoming,
          PIN,
        ),
      ).toMatchObject({ success: false, error: "INVALID_INPUT" });
      expect(
        await recordCashHandover(
          jornada,
          makeCashCountInput(50000),
          id as number,
          PIN,
        ),
      ).toMatchObject({ success: false, error: "INVALID_INPUT" });
    }
    for (const pin of [null, 123456, "", "12345", "1234567", "abcdef"])
      expect(
        await recordCashHandover(
          jornada,
          makeCashCountInput(50000),
          incoming,
          pin as string,
        ),
      ).toMatchObject({ success: false });
    expect(
      await recordCashHandover(jornada, makeCashCountInput(50000), owner, PIN),
    ).toMatchObject({ success: false });
    expect(
      await recordCashHandover(
        jornada,
        { ...makeCashCountInput(50000), recountOfId: 1 },
        incoming,
        PIN,
      ),
    ).toMatchObject({ success: false, error: "INVALID_RECOUNT" });
    expect(
      await recordCashHandover(
        jornada,
        {
          ...makeCashCountInput(50000),
          denominations: [{ kind: "BILL", valueCents: 50000, quantity: -1 }],
        },
        incoming,
        PIN,
      ),
    ).toMatchObject({ success: false });
  });

  it("requires explicit confirmation of an empty cash drawer", async () => {
    const input = {
      ...makeCashCountInput(0, "Empty drawer"),
      confirmEmpty: false,
    };
    expect(
      await recordCashHandover(jornada, input, incoming, PIN),
    ).toMatchObject({ success: false, error: "CONFIRM_EMPTY_REQUIRED" });
    expect(
      await recordCashHandover(
        jornada,
        { ...input, confirmEmpty: true },
        incoming,
        PIN,
      ),
    ).toMatchObject({
      success: true,
      data: { countedAmount: 0, difference: -50000 },
    });
  });

  it("requires both a signed-in session and the live reconcile permission", async () => {
    logout();
    expect(
      await recordCashHandover(
        jornada,
        makeCashCountInput(50000),
        incoming,
        PIN,
      ),
    ).toMatchObject({ success: false, error: "PERMISSION DENIED" });
    loginAs("STAFF", incoming);
    await prisma.rolePermission.create({
      data: { role: "STAFF", capability: "jornada.reconcile", enabled: false },
    });
    expect(
      await recordCashHandover(
        jornada,
        makeCashCountInput(50000),
        next,
        OTHER_PIN,
      ),
    ).toMatchObject({ success: false, error: "PERMISSION DENIED" });
    expect(await getCashHandoverContext(jornada)).toBeNull();
  });

  it("only permits the current custodian to deliver, even when another user can reconcile", async () => {
    loginAs("SUPERVISOR", next);
    expect(
      await recordCashHandover(
        jornada,
        makeCashCountInput(50000),
        incoming,
        PIN,
      ),
    ).toMatchObject({ success: false, error: "NOT_CASH_CUSTODIAN" });
    expect(await getCashHandoverContext(jornada)).toMatchObject({
      operatorId: owner,
      canDeliver: false,
      recipients: [],
    });
  });

  it("replays a committed request without duplicate records and rejects changed payloads", async () => {
    const input = makeCashCountInput(50000);
    const first = await recordCashHandover(jornada, input, incoming, PIN);
    expect(first.success).toBe(true);
    expect(
      await recordCashHandover(
        jornada,
        { ...input, requestId: input.requestId.toUpperCase() },
        incoming,
        PIN,
      ),
    ).toEqual(first);
    expect(
      await recordCashHandover(
        jornada,
        { ...input, note: "Changed" },
        incoming,
        PIN,
      ),
    ).toMatchObject({ success: false, error: "IDEMPOTENCY_CONFLICT" });
    expect(
      await recordCashHandover(jornada, input, next, OTHER_PIN),
    ).toMatchObject({ success: false, error: "IDEMPOTENCY_CONFLICT" });
    expect(
      await recordCashHandover(jornada, input, incoming, "000000"),
    ).toMatchObject({ success: false, error: "INVALID_HANDOVER_PIN" });
    expect(await recordCashCount(jornada, input)).toMatchObject({
      success: false,
      error: "IDEMPOTENCY_CONFLICT",
    });
    expect(await prisma.cash_count.count({ where: { type: "HANDOVER" } })).toBe(
      1,
    );
  });

  it("rejects new handovers after closure while allowing a confirmed request retry", async () => {
    const input = makeCashCountInput(50000);
    const first = await recordCashHandover(jornada, input, incoming, PIN);
    expect(
      await closeJornada(jornada, makeCashCountInput(50000)),
    ).toMatchObject({ success: true });
    expect(await recordCashHandover(jornada, input, incoming, PIN)).toEqual(
      first,
    );
    expect(
      await recordCashHandover(
        jornada,
        makeCashCountInput(50000),
        incoming,
        PIN,
      ),
    ).toMatchObject({ success: false, error: "La jornada ya está cerrada" });
  });

  it("includes both participants in restricted history and exports without exposing expected cash", async () => {
    const receipt = await recordCashHandover(
      jornada,
      makeCashCountInput(49000, "Counted shortage"),
      incoming,
      PIN,
    );
    expect(receipt.success).toBe(true);
    await prisma.users.update({
      where: { id: incoming },
      data: { name: "Renamed later" },
    });
    loginAs("STAFF", incoming);
    const history = await getCashCountHistory({
      jornadaId: jornada,
      type: "HANDOVER",
    });
    expect(history).toMatchObject({
      success: true,
      data: {
        total: 1,
        items: [
          {
            operatorId: owner,
            incomingOperatorId: incoming,
            incomingOperatorName: "Incoming",
          },
        ],
      },
    });
    if (!history.success) throw new Error(history.error);
    expect(history.data.items[0]).not.toHaveProperty("difference");
    expect(history.data.items[0]).not.toHaveProperty("cashSummary");
    const csv = await exportCashCountHistory({ type: "HANDOVER" });
    expect(csv.success && csv.data).toContain('"Recibe"');
    expect(csv.success && csv.data).toContain('"Incoming"');
    expect(csv.success && csv.data).not.toContain('"Diferencia MXN"');
    expect(await getJornadaClosingSummary(jornada)).toMatchObject({
      success: true,
      data: { counts: [{ type: "HANDOVER" }] },
    });
    loginAs("STAFF", next);
    expect(
      await getCashCountHistory({ jornadaId: jornada, type: "HANDOVER" }),
    ).toMatchObject({ success: true, data: { total: 0 } });
  });

  it("serializes simultaneous deliveries so responsibility changes only once", async () => {
    const results = await Promise.all([
      recordCashHandover(jornada, makeCashCountInput(50000), incoming, PIN),
      recordCashHandover(jornada, makeCashCountInput(50000), next, OTHER_PIN),
    ]);
    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(results.find((r) => !r.success)).toMatchObject({
      error: "NOT_CASH_CUSTODIAN",
    });
    expect(await prisma.cash_count.count({ where: { type: "HANDOVER" } })).toBe(
      1,
    );
  });

  it("waits for cash movements under the shared jornada lock and counts them in the receipt", async () => {
    let acquired!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const movement = prisma.$transaction(async (tx) => {
      await acquireJornadaTicketLock(tx, jornada);
      acquired();
      await gate;
      await tx.bill.create({
        data: {
          amountCents: 1000,
          category: "Race",
          date: new Date(),
          registered_by: owner,
          jornadaId: jornada,
          payment_method: "CASH",
        },
      });
    });
    await ready;
    const handover = recordCashHandover(
      jornada,
      makeCashCountInput(49000),
      incoming,
      PIN,
    );
    release();
    await movement;
    expect(await handover).toMatchObject({
      success: true,
      data: { expectedAmount: 49000, difference: 0 },
    });
  });
});
