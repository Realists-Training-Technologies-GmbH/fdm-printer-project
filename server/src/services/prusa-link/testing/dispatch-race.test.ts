import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { PrintJob } from "@/entities";
import { createTrackingHarness, type TrackingHarness } from "@/services/prusa-link/testing/test-harness";

/**
 * The per-printer dispatch mutex (`withPrinterLock`) makes the claim — pick next
 * job → ensurePrinterIdle → flip to STARTING — atomic, so two concurrent
 * dispatches to the same printer can't both pass the idle check.
 */
describe("dispatch race — per-printer mutex", () => {
  let h: TrackingHarness;
  beforeEach(async () => {
    h = await createTrackingHarness();
  });
  afterEach(async () => {
    await h.destroy();
  });

  const repo = () => h.dataSource.getRepository(PrintJob);
  const queued = (printerId: number, fileName: string, queuePosition: number) =>
    repo().save(repo().create({ printerId, fileName, status: "QUEUED", queuePosition, metadata: null }));

  it("two concurrent dispatches to one printer: exactly one wins, the other stays QUEUED", async () => {
    const queue = h.makePrintQueueService();
    // Skip the real upload — we're testing the claim section, not the transfer.
    (queue as any).dispatchInBackground = async () => {};

    const j1 = await queued(1, "a.bgcode", 0);
    const j2 = await queued(1, "b.bgcode", 1);

    const results = await Promise.allSettled([queue.submitToPrinter(1, j1.id), queue.submitToPrinter(1, j2.id)]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.message).toMatch(/busy/i);

    // Exactly one job is STARTING; the other never left the queue.
    const after = await repo().find({ where: { printerId: 1 }, order: { id: "ASC" } });
    expect(after.filter((j) => j.status === "STARTING")).toHaveLength(1);
    expect(after.filter((j) => j.status === "QUEUED")).toHaveLength(1);
  });

  it("concurrent processQueue calls for one printer dispatch only one job", async () => {
    const queue = h.makePrintQueueService();
    (queue as any).dispatchInBackground = async () => {};
    // processQueue checks connectivity; report the printer as connected.
    (queue as any).isPrinterConnected = () => ({ connected: true });

    await queued(1, "head.bgcode", 0);
    await queued(1, "next.bgcode", 1);

    await Promise.allSettled([queue.processQueue(1), queue.processQueue(1)]);

    const after = await repo().find({ where: { printerId: 1 } });
    // Only the head job is claimed; the second processQueue saw it busy.
    expect(after.filter((j) => j.status === "STARTING")).toHaveLength(1);
  });

  it("dispatches to different printers run concurrently (lock is per-printer)", async () => {
    const queue = h.makePrintQueueService();
    (queue as any).dispatchInBackground = async () => {};

    const j1 = await queued(1, "p1.bgcode", 0);
    const j2 = await queued(2, "p2.bgcode", 0);

    const results = await Promise.allSettled([queue.submitToPrinter(1, j1.id), queue.submitToPrinter(2, j2.id)]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    expect((await repo().findOneBy({ id: j1.id }))?.status).toBe("STARTING");
    expect((await repo().findOneBy({ id: j2.id }))?.status).toBe("STARTING");
  });

  it("serializes the critical section (no interleaving) via withPrinterLock", async () => {
    const queue = h.makePrintQueueService();
    const order: string[] = [];
    const section = (tag: string) => async () => {
      order.push(`${tag}:enter`);
      await new Promise((r) => setTimeout(r, 10));
      order.push(`${tag}:exit`);
    };

    await Promise.all([
      (queue as any).withPrinterLock(1, section("A")),
      (queue as any).withPrinterLock(1, section("B")),
    ]);

    // A must fully complete before B enters — no enter/enter/exit/exit interleave.
    expect(order).toEqual(["A:enter", "A:exit", "B:enter", "B:exit"]);
  });

  it("a failing critical section does not wedge the printer's lock", async () => {
    const queue = h.makePrintQueueService();
    // First holder throws; the second must still run (chain swallows the error).
    const first = (queue as any).withPrinterLock(1, async () => {
      throw new Error("boom");
    });
    await expect(first).rejects.toThrow("boom");

    const second = (queue as any).withPrinterLock(1, async () => "ok");
    await expect(second).resolves.toBe("ok");
  });
});
