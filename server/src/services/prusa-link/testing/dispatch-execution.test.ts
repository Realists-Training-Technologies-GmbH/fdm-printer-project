import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { PrintJob } from "@/entities";
import {
  createTrackingHarness,
  FakePrinterApi,
  type TrackingHarness,
} from "@/services/prusa-link/testing/test-harness";

const PRINTER_ID = 1;
const TEMP_FOLDER = "prusahero-temp"; // PRINTER_TEMP_FOLDER in print-queue.service.ts

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/**
 * Exercises the real dispatch execution path (dispatchInBackground →
 * dispatchToPrinter) with a fake IPrinterApi: success, permanent failure,
 * transient retry, user cancel, temp-folder cleanup — plus the queue
 * auto-advance that fires the next job when one finishes.
 */
describe("dispatch execution — upload, retry, cancel", () => {
  let h: TrackingHarness;
  beforeEach(async () => {
    h = await createTrackingHarness();
  });
  afterEach(async () => {
    await h.destroy();
  });

  const repo = () => h.dataSource.getRepository(PrintJob);
  const startingJob = (over: Partial<PrintJob> = {}) =>
    repo().save(
      repo().create({
        printerId: PRINTER_ID,
        fileName: "part.bgcode",
        status: "STARTING",
        queuePosition: 0,
        fileStorageId: "fs-1",
        metadata: null,
        ...over,
      }),
    );
  const dispatch = (queue: ReturnType<TrackingHarness["makePrintQueueService"]>, jobId: number) =>
    (queue as any).dispatchInBackground(PRINTER_ID, jobId) as Promise<void>;
  const onEvent = (name: string) => {
    const seen: any[] = [];
    h.eventEmitter.on(name, (p) => seen.push(p));
    return seen;
  };

  it("uploads a File-Storage job and starts it → PRINTING, leaves the queue", async () => {
    const api = new FakePrinterApi();
    const queue = h.makePrintQueueService({ printerApi: api });
    const submitted = onEvent("printQueue.jobSubmitted");
    const job = await startingJob();

    await dispatch(queue, job.id);

    const after = await repo().findOneBy({ id: job.id });
    expect(after?.status).toBe("PRINTING");
    expect(after?.queuePosition).toBeNull();
    expect(after?.startedAt).not.toBeNull();
    // Uploaded with start-after-upload into the temp folder.
    expect(api.calls.uploadFile).toHaveLength(1);
    expect(api.calls.uploadFile[0]).toMatchObject({
      startPrint: true,
      targetPath: TEMP_FOLDER,
      fileName: "part.bgcode",
    });
    expect(submitted).toHaveLength(1);
  });

  it("starts a USB-file job without uploading", async () => {
    const api = new FakePrinterApi();
    const queue = h.makePrintQueueService({ printerApi: api });
    const job = await startingJob({ fileStorageId: null, usbFilePath: "Production/part.bgcode" });

    await dispatch(queue, job.id);

    expect(api.calls.uploadFile).toHaveLength(0);
    expect(api.calls.startPrint).toEqual(["Production/part.bgcode"]);
    expect((await repo().findOneBy({ id: job.id }))?.status).toBe("PRINTING");
  });

  it("sweeps leftover temp files before uploading the next print", async () => {
    const api = new FakePrinterApi();
    api.tempFiles = [{ path: `${TEMP_FOLDER}/old1.bgcode` }, { path: `${TEMP_FOLDER}/old2.bgcode` }];
    const queue = h.makePrintQueueService({ printerApi: api });
    const job = await startingJob();

    await dispatch(queue, job.id);

    expect(api.calls.deleteFile).toEqual([`${TEMP_FOLDER}/old1.bgcode`, `${TEMP_FOLDER}/old2.bgcode`]);
    expect(api.calls.uploadFile).toHaveLength(1);
  });

  it("rolls a permanently-failed upload back to QUEUED without retrying", async () => {
    const api = new FakePrinterApi();
    api.uploadBehavior = async () => {
      throw new Error("disk error"); // no response.status / not transient
    };
    const queue = h.makePrintQueueService({ printerApi: api });
    const failed = onEvent("printQueue.jobSubmissionFailed");
    const job = await startingJob();

    await dispatch(queue, job.id);

    const after = await repo().findOneBy({ id: job.id });
    expect(after?.status).toBe("QUEUED");
    expect(after?.queuePosition).toBe(0); // slot preserved for retry
    expect(after?.statusReason).toMatch(/failed/i);
    expect(api.calls.uploadFile).toHaveLength(1); // NOT retried
    expect(failed[0]).toMatchObject({ cancelled: false });
  });

  it("retries a transient 5xx and succeeds on the next attempt", async () => {
    const api = new FakePrinterApi();
    let attempts = 0;
    api.uploadBehavior = async () => {
      attempts++;
      if (attempts === 1) {
        const e: any = new Error("503 Service Unavailable");
        e.response = { status: 503 };
        throw e;
      }
    };
    const queue = h.makePrintQueueService({ printerApi: api });
    const job = await startingJob();

    await dispatch(queue, job.id); // first retry backoff is 2000ms

    expect(attempts).toBe(2);
    expect((await repo().findOneBy({ id: job.id }))?.status).toBe("PRINTING");
  }, 10000);

  it("rolls back as 'cancelled by user' when the dispatch is aborted mid-upload", async () => {
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
    const queue = h.makePrintQueueService({ printerApi: api });
    const failed = onEvent("printQueue.jobSubmissionFailed");
    const job = await startingJob();

    const p = dispatch(queue, job.id);
    await tick(); // let it reach uploadFile and register the abort listener
    expect(queue.cancelDispatch(PRINTER_ID)).toBe(true);
    await p;

    const after = await repo().findOneBy({ id: job.id });
    expect(after?.status).toBe("QUEUED");
    expect(after?.statusReason).toMatch(/cancel/i);
    expect(failed[0]).toMatchObject({ cancelled: true });
  });

  it("auto-advances the queue: completing a job dispatches the next QUEUED one", async () => {
    const api = new FakePrinterApi();
    const queue = h.makePrintQueueService({ printerApi: api });
    // processQueue gates on connectivity — report the printer as reachable.
    (queue as any).isPrinterConnected = () => ({ connected: true });
    // Next job waiting in the queue.
    await repo().save(
      repo().create({
        printerId: PRINTER_ID,
        fileName: "next.bgcode",
        status: "QUEUED",
        queuePosition: 0,
        usbFilePath: "next.bgcode",
        metadata: null,
      }),
    );

    const submitted = new Promise((res) => h.eventEmitter.once("printQueue.jobSubmitted", res));
    // A previous job just finished on this printer.
    h.eventEmitter.emit("printJob.completed", { printerId: PRINTER_ID });
    await submitted;

    expect(api.calls.startPrint).toEqual(["next.bgcode"]);
    expect((await repo().findOneBy({ fileName: "next.bgcode" }))?.status).toBe("PRINTING");
  });
});
