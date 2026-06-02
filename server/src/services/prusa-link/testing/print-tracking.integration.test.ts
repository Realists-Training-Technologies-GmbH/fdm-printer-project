import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { PrintJob } from "@/entities";
import { PrusaBuddySimulator } from "@/services/prusa-link/testing/prusa-buddy-simulator";
import { createTrackingHarness, type TrackingHarness } from "@/services/prusa-link/testing/test-harness";

const PRINTER_ID = 1;

describe("print tracking — firmware-faithful scenarios through the real observer", () => {
  let h: TrackingHarness;

  beforeEach(async () => {
    h = await createTrackingHarness();
  });
  afterEach(async () => {
    await h.destroy();
  });

  const jobs = () =>
    h.dataSource.getRepository(PrintJob).find({ where: { printerId: PRINTER_ID }, order: { id: "ASC" } });
  const activeJob = () => h.printJobService.getActivePrintJob(PRINTER_ID);

  it("happy path: IDLE → PRINTING → FINISHED closes the job as COMPLETED", async () => {
    const sim = new PrusaBuddySimulator();
    await h.poll(sim.idle(), PRINTER_ID);
    await h.poll(sim.startPrint({ display: "part.bgcode" }).progress(5), PRINTER_ID);
    await h.poll(sim.progress(60), PRINTER_ID);
    await h.poll(sim.finish(), PRINTER_ID);

    const all = await jobs();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("COMPLETED");
    expect(await activeJob()).toBeNull();
    expect(h.emittedJobEvents).toContain("started");
    expect(h.emittedJobEvents).toContain("completed");
  });

  it("XL behaviour: PRINTING → READY (skips FINISHED) still closes via the safety net", async () => {
    const sim = new PrusaBuddySimulator({ ready: true });
    await h.poll(sim.startPrint().progress(10), PRINTER_ID);
    await h.poll(sim.progress(99), PRINTER_ID);
    // ready flag → a finished print reports READY, not FINISHED.
    await h.poll(sim.finish(), PRINTER_ID);

    const all = await jobs();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("COMPLETED");
  });

  it("pause then resume then finish: one job, ends COMPLETED", async () => {
    const sim = new PrusaBuddySimulator();
    await h.poll(sim.startPrint().progress(20), PRINTER_ID);
    await h.poll(sim.pause(), PRINTER_ID);
    expect(await activeJob()).toBeNull(); // PAUSED is not "PRINTING-active"
    expect((await jobs())[0].status).toBe("PAUSED");
    await h.poll(sim.resume().progress(40), PRINTER_ID);
    expect((await jobs())[0].status).toBe("PRINTING");
    await h.poll(sim.finish(), PRINTER_ID);

    const all = await jobs();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("COMPLETED");
    // The mid-flight PAUSED→PRINTING transitions were asserted via status above.
    // (handlePrintPaused/Resumed update status but don't emit dedicated events;
    // the UI reflects them through the periodic socket snapshot.)
    expect(h.emittedJobEvents).toContain("started");
    expect(h.emittedJobEvents).toContain("completed");
  });

  it("user cancel: PRINTING → STOPPED ends the job as CANCELLED (not FAILED)", async () => {
    const sim = new PrusaBuddySimulator();
    await h.poll(sim.startPrint().progress(30), PRINTER_ID);
    await h.poll(sim.cancel(), PRINTER_ID);

    const all = await jobs();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("CANCELLED");
  });

  // --- regression: bugs fixed by the ATTENTION/BUSY firmware-faithful logic ---

  it("filament runout (ATTENTION) does NOT close the job, and resume → finish completes it", async () => {
    const sim = new PrusaBuddySimulator();
    await h.poll(sim.startPrint({ display: "part.bgcode" }).progress(25), PRINTER_ID);
    // ATTENTION mid-print — job must stay PRINTING, not be closed.
    await h.poll(sim.filamentRunout("Filament runout"), PRINTER_ID);
    expect((await jobs())[0].status).toBe("PRINTING");
    expect(await activeJob()).not.toBeNull();
    // User reloads filament and the print resumes, then finishes.
    await h.poll(sim.resolveAttentionAndResume().progress(70), PRINTER_ID);
    await h.poll(sim.finish(), PRINTER_ID);

    const all = await jobs();
    expect(all).toHaveLength(1); // never duplicated
    expect(all[0].status).toBe("COMPLETED");
  });

  it("ATTENTION → IDLE closes the stuck job (Capa A — the stuck-printer bug)", async () => {
    const sim = new PrusaBuddySimulator();
    await h.poll(sim.startPrint().progress(50), PRINTER_ID);
    // Print ends by routing through a "remove the print" ATTENTION prompt...
    await h.poll(sim.filamentRunout("Remove the print"), PRINTER_ID);
    expect((await jobs())[0].status).toBe("PRINTING"); // not closed yet
    // ...then the user clears it and the printer settles to IDLE.
    await h.poll(sim.becomeIdleOrReady(), PRINTER_ID);

    const all = await jobs();
    expect(all[0].status).toBe("COMPLETED"); // no longer stuck
    expect(await activeJob()).toBeNull();
  });

  it("crash recovery (BUSY) mid-print does NOT close the job; resume → finish completes it", async () => {
    const sim = new PrusaBuddySimulator();
    await h.poll(sim.startPrint().progress(40), PRINTER_ID);
    // Automatic crash recovery reports BUSY *while still printing*.
    await h.poll(sim.crashRecoveryAuto(), PRINTER_ID);
    expect((await jobs())[0].status).toBe("PRINTING"); // must NOT be closed
    await h.poll(sim.resolveAttentionAndResume().progress(80), PRINTER_ID);
    await h.poll(sim.finish(), PRINTER_ID);

    const all = await jobs();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("COMPLETED");
  });

  it("PRINTING → BUSY → IDLE closes the job (prev=BUSY safety-net path)", async () => {
    const sim = new PrusaBuddySimulator();
    await h.poll(sim.startPrint().progress(45), PRINTER_ID);
    await h.poll(sim.crashRecoveryAuto(), PRINTER_ID); // BUSY
    await h.poll(sim.becomeIdleOrReady(), PRINTER_ID); // settles to IDLE

    const all = await jobs();
    expect(all[0].status).toBe("COMPLETED");
    expect(await activeJob()).toBeNull();
  });

  it("ERROR ends the job as FAILED", async () => {
    const sim = new PrusaBuddySimulator();
    await h.poll(sim.startPrint().progress(15), PRINTER_ID);
    await h.poll(sim.fatalError("Thermal runaway"), PRINTER_ID);

    const all = await jobs();
    expect(all[0].status).toBe("FAILED");
  });

  // --- regression: STARTING dispatch adoption (commits cd6af79 / c64e501) ---

  it("adopts the in-flight STARTING dispatch when the poll detects PRINTING (by printerId)", async () => {
    // Simulate a dispatch in flight: a STARTING job with a real fileStorageId,
    // created by the queue, whose upload is still streaming.
    const repo = h.dataSource.getRepository(PrintJob);
    const starting = await repo.save(
      repo.create({
        printerId: PRINTER_ID,
        fileName: "production_part.bgcode",
        status: "STARTING",
        analysisState: "ANALYZED",
        fileStorageId: "fs-123",
        fileFormat: "bgcode",
        metadata: null,
      }),
    );

    // The printer starts printing as bytes arrive; PrusaLink reports the FAT
    // short name, which won't equal the stored fileName.
    const sim = new PrusaBuddySimulator();
    sim.startPrint({ display: "PRODUC~1.BGC", name: "PRODUC~1.BGC", path: "/usb/PRODUC~1.BGC" }).progress(2);
    await h.poll(sim, PRINTER_ID);

    const all = await jobs();
    expect(all).toHaveLength(1); // adopted, not orphaned into a 2nd job
    expect(all[0].id).toBe(starting.id);
    expect(all[0].status).toBe("PRINTING");
    expect(all[0].fileStorageId).toBe("fs-123"); // metadata/thumbnail link preserved
  });

  // --- regression: server-restart missed terminal edge (seedLastPollState) ---

  it("after a restart, a print that finished during downtime is reconciled to COMPLETED", async () => {
    // A PRINTING row survives a restart.
    const repo = h.dataSource.getRepository(PrintJob);
    await repo.save(
      repo.create({
        printerId: PRINTER_ID,
        fileName: "left_running.bgcode",
        status: "PRINTING",
        analysisState: "ANALYZED",
        fileStorageId: "fs-9",
        startedAt: new Date(),
        metadata: null,
      }),
    );

    // BootTask seeds lastPollState from active jobs so the first poll has the
    // right `prev`.
    await h.eventsCache.seedLastPollState();

    // The printer is now idle (it finished while we were down).
    const sim = new PrusaBuddySimulator().becomeIdleOrReady();
    await h.poll(sim, PRINTER_ID);

    const all = await jobs();
    expect(all[0].status).toBe("COMPLETED");
  });
});
