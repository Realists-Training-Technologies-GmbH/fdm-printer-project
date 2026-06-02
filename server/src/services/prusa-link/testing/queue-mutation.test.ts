import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { PrintJob } from "@/entities";
import {
  createTrackingHarness,
  FakePrinterApi,
  type TrackingHarness,
} from "@/services/prusa-link/testing/test-harness";

const PRINTER_ID = 1;
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// A fake whose upload hangs until the dispatch's AbortSignal fires.
function abortableApi() {
  const api = new FakePrinterApi();
  api.uploadBehavior = (input) =>
    new Promise((_, reject) => {
      const fail = () => {
        const e: any = new Error("canceled");
        e.code = "ERR_CANCELED";
        reject(e);
      };
      if (input.signal?.aborted) return fail();
      input.signal?.addEventListener("abort", fail);
    });
  return api;
}

describe("queue mutation aborts in-flight transfers (no surprise print on an uncleared bed)", () => {
  let h: TrackingHarness;
  beforeEach(async () => {
    h = await createTrackingHarness();
  });
  afterEach(async () => {
    await h.destroy();
  });

  const repo = () => h.dataSource.getRepository(PrintJob);
  const startingMidUpload = () =>
    repo().save(
      repo().create({
        printerId: PRINTER_ID,
        fileName: "a.bgcode",
        status: "STARTING",
        queuePosition: 0,
        fileStorageId: "fs-1",
        metadata: null,
      }),
    );

  it("removeFromQueue aborts the in-flight STARTING upload — the print never starts", async () => {
    const api = abortableApi();
    const queue = h.makePrintQueueService({ printerApi: api });
    const job = await startingMidUpload();

    const p = (queue as any).dispatchInBackground(PRINTER_ID, job.id) as Promise<void>;
    await tick(); // reach uploadFile (now hanging)

    await queue.removeFromQueue(job.id);
    await p; // dispatch settles after the abort

    const after = await repo().findOneBy({ id: job.id });
    expect(after?.status).not.toBe("PRINTING"); // the crucial safety property
    expect(api.calls.uploadFile).toHaveLength(1); // upload was attempted then aborted
  });

  it("clearQueue aborts the in-flight STARTING upload too", async () => {
    const api = abortableApi();
    const queue = h.makePrintQueueService({ printerApi: api });
    const job = await startingMidUpload();
    // A separate QUEUED job that clearQueue will reset.
    await repo().save(
      repo().create({
        printerId: PRINTER_ID,
        fileName: "b.bgcode",
        status: "QUEUED",
        queuePosition: 1,
        metadata: null,
      }),
    );

    const p = (queue as any).dispatchInBackground(PRINTER_ID, job.id) as Promise<void>;
    await tick();

    await queue.clearQueue(PRINTER_ID);
    await p;

    expect((await repo().findOneBy({ id: job.id }))?.status).not.toBe("PRINTING");
    expect((await repo().findOneBy({ fileName: "b.bgcode" }))?.status).toBe("PENDING");
  });
});
