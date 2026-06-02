import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { PrintJob } from "@/entities";
import { PrusaBuddySimulator } from "@/services/prusa-link/testing/prusa-buddy-simulator";
import { createTrackingHarness, type TrackingHarness } from "@/services/prusa-link/testing/test-harness";

const PRINTER_ID = 1;
const NEW_JOB_ID = 999; // the job we're trying to dispatch (the `exceptJobId`)

/**
 * Capa B: `ensurePrinterIdle` cross-checks the live hardware state before
 * blocking a dispatch, so a stale PRINTING/PAUSED row can't permanently wedge a
 * printer that is physically idle.
 */
describe("ensurePrinterIdle — live-state reconciliation (Capa B)", () => {
  let h: TrackingHarness;
  beforeEach(async () => {
    h = await createTrackingHarness();
  });
  afterEach(async () => {
    await h.destroy();
  });

  const repo = () => h.dataSource.getRepository(PrintJob);
  const ensureIdle = (queue: ReturnType<TrackingHarness["makePrintQueueService"]>) =>
    (queue as any).ensurePrinterIdle(PRINTER_ID, NEW_JOB_ID) as Promise<void>;

  it("clears a stale PRINTING job when the printer is live-idle, then allows dispatch", async () => {
    const queue = h.makePrintQueueService();
    const stale = await repo().save(
      repo().create({ printerId: PRINTER_ID, fileName: "old.bgcode", status: "PRINTING", metadata: null }),
    );
    // The printer is actually idle right now (its terminal edge was missed).
    await h.seedLiveState(new PrusaBuddySimulator().becomeIdleOrReady(), PRINTER_ID);

    await expect(ensureIdle(queue)).resolves.toBeUndefined(); // does not throw

    const after = await repo().findOneBy({ id: stale.id });
    expect(after?.status).toBe("UNKNOWN");
    expect(after?.statusReason).toContain("Reconciled on dispatch");
  });

  it("still blocks dispatch when the printer is genuinely PRINTING", async () => {
    const queue = h.makePrintQueueService();
    await repo().save(
      repo().create({ printerId: PRINTER_ID, fileName: "running.bgcode", status: "PRINTING", metadata: null }),
    );
    await h.seedLiveState(new PrusaBuddySimulator().startPrint().progress(50), PRINTER_ID);

    await expect(ensureIdle(queue)).rejects.toThrow(/busy/i);
  });

  it("does NOT clear a STARTING dispatch even if the printer reads idle (upload in flight)", async () => {
    const queue = h.makePrintQueueService();
    const starting = await repo().save(
      repo().create({ printerId: PRINTER_ID, fileName: "uploading.bgcode", status: "STARTING", metadata: null }),
    );
    // The printer is still idle because the file is mid-upload (Print-After-Upload
    // hasn't fired). This must NOT be reconciled away.
    await h.seedLiveState(new PrusaBuddySimulator().idle(), PRINTER_ID);

    await expect(ensureIdle(queue)).rejects.toThrow(/busy/i);
    expect((await repo().findOneBy({ id: starting.id }))?.status).toBe("STARTING");
  });

  it("does NOT reconcile when the printer is BUSY (crash recovery mid-print)", async () => {
    const queue = h.makePrintQueueService();
    await repo().save(
      repo().create({ printerId: PRINTER_ID, fileName: "recovering.bgcode", status: "PRINTING", metadata: null }),
    );
    await h.seedLiveState(new PrusaBuddySimulator().startPrint().crashRecoveryAuto(), PRINTER_ID);

    await expect(ensureIdle(queue)).rejects.toThrow(/busy/i);
  });

  it("blocks (conservative) when there is no fresh live state", async () => {
    const queue = h.makePrintQueueService();
    await repo().save(
      repo().create({ printerId: PRINTER_ID, fileName: "unknown.bgcode", status: "PRINTING", metadata: null }),
    );
    // No seedLiveState call → no snapshot → fall back to blocking.
    await expect(ensureIdle(queue)).rejects.toThrow(/busy/i);
  });
});
