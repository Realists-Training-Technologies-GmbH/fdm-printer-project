import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { PrintJob } from "@/entities";
import { PrusaBuddySimulator } from "@/services/prusa-link/testing/prusa-buddy-simulator";
import { createTrackingHarness, type TrackingHarness } from "@/services/prusa-link/testing/test-harness";

const PRINTER_ID = 1;

describe("addToQueue position assignment is race-free", () => {
  let h: TrackingHarness;
  beforeEach(async () => {
    h = await createTrackingHarness();
  });
  afterEach(async () => {
    await h.destroy();
  });

  it("concurrent adds to one printer get distinct queue positions (no TOCTOU duplicate)", async () => {
    const queue = h.makePrintQueueService();
    const repo = h.dataSource.getRepository(PrintJob);
    const j1 = await repo.save(
      repo.create({ printerId: PRINTER_ID, fileName: "a.bgcode", status: "PENDING", metadata: null }),
    );
    const j2 = await repo.save(
      repo.create({ printerId: PRINTER_ID, fileName: "b.bgcode", status: "PENDING", metadata: null }),
    );

    await Promise.all([queue.addToQueue(PRINTER_ID, j1.id), queue.addToQueue(PRINTER_ID, j2.id)]);

    const positions = (await repo.find({ where: { printerId: PRINTER_ID } })).map((j) => j.queuePosition).sort();
    expect(positions).toEqual([0, 1]); // without the lock both would read max=null → [0, 0]
  });
});

describe("poll progress is applied after the start transition (not to the closing job)", () => {
  let h: TrackingHarness;
  beforeEach(async () => {
    h = await createTrackingHarness();
  });
  afterEach(async () => {
    await h.destroy();
  });

  it("does not stamp the new print's progress onto the previous (about-to-close) job", async () => {
    const repo = h.dataSource.getRepository(PrintJob);
    // A zombie PRINTING job for a DIFFERENT file, at 50%.
    const zombie = await repo.save(
      repo.create({
        printerId: PRINTER_ID,
        fileName: "old.bgcode",
        status: "PRINTING",
        progress: 50,
        startedAt: new Date(),
        metadata: null,
      }),
    );

    // The printer is now printing a new file at 12%.
    await h.poll(new PrusaBuddySimulator().startPrint({ display: "new.bgcode" }).progress(12), PRINTER_ID);

    const old = await repo.findOneBy({ id: zombie.id });
    expect(old?.status).toBe("UNKNOWN"); // closed by handlePrintStarted (different file)
    expect(old?.progress).toBe(50); // NOT overwritten with the new print's 12%

    const fresh = await repo.findOneBy({ fileName: "new.bgcode" });
    expect(fresh?.status).toBe("PRINTING");
    expect(fresh?.progress).toBe(12); // the new job got the progress
  });
});
