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

  it("cancelDispatch also tells the printer to abort its transfer (frees the MK3's locked slot)", async () => {
    // Aborting the local stream isn't enough: the legacy Einsy MK3 keeps its
    // single transfer slot open and 409s the next dispatch. cancelDispatch
    // must call the printer's abortTransfer to release it.
    const api = abortableApi();
    const queue = h.makePrintQueueService({ printerApi: api });
    const job = await startingMidUpload();

    const p = (queue as any).dispatchInBackground(PRINTER_ID, job.id) as Promise<void>;
    await tick(); // reach uploadFile (now hanging on the abort signal)

    expect(queue.cancelDispatch(PRINTER_ID)).toBe(true);
    await p; // dispatch settles after the abort
    await tick(); // let the fire-and-forget abortTransfer run

    expect(api.calls.abortTransfer).toBe(1);
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

describe("requeueCancelledJobAtFront — manual cancel restarts the file in one click", () => {
  let h: TrackingHarness;
  beforeEach(async () => {
    h = await createTrackingHarness();
  });
  afterEach(async () => {
    await h.destroy();
  });
  const repo = () => h.dataSource.getRepository(PrintJob);

  it("clones the cancelled job into a fresh QUEUED job at position 0, shifting the rest", async () => {
    const queue = h.makePrintQueueService();
    // An existing queued job currently sitting at the front.
    const existing = await repo().save(
      repo().create({
        printerId: PRINTER_ID,
        fileName: "existing.bgcode",
        status: "QUEUED",
        queuePosition: 0,
        fileStorageId: "fs-existing",
        metadata: null,
      }),
    );
    // The just-cancelled print (out of the queue, in history).
    const cancelled = await repo().save(
      repo().create({
        printerId: PRINTER_ID,
        fileName: "cancelled.bgcode",
        status: "CANCELLED",
        queuePosition: null,
        fileStorageId: "fs-cancelled",
        fileFormat: "bgcode",
        metadata: { layerHeight: 0.2 } as any,
      }),
    );

    const newJob = await queue.requeueCancelledJobAtFront(cancelled);

    expect(newJob).not.toBeNull();
    expect(newJob!.id).not.toBe(cancelled.id); // a fresh row, not the cancelled one
    expect(newJob!.status).toBe("QUEUED");
    expect(newJob!.queuePosition).toBe(0); // at the front
    expect(newJob!.fileStorageId).toBe("fs-cancelled"); // same file + metadata
    expect(newJob!.fileName).toBe("cancelled.bgcode");

    // The cancelled job stays in history untouched.
    expect((await repo().findOneBy({ id: cancelled.id }))?.status).toBe("CANCELLED");
    // The previously-front job got shifted down to make room.
    expect((await repo().findOneBy({ id: existing.id }))?.queuePosition).toBe(1);
  });

  it("returns null when the cancelled job has no re-printable file reference", async () => {
    const queue = h.makePrintQueueService();
    const cancelled = await repo().save(
      repo().create({
        printerId: PRINTER_ID,
        fileName: "manual.bgcode",
        status: "CANCELLED",
        queuePosition: null,
        fileStorageId: null,
        usbFilePath: null,
        metadata: null,
      }),
    );

    expect(await queue.requeueCancelledJobAtFront(cancelled)).toBeNull();
  });
});
