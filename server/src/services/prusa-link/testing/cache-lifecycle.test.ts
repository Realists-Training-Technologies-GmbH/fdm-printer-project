import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import EventEmitter2 from "eventemitter2";
import { PrinterFirmwareCache } from "@/state/printer-firmware.cache";
import { PrinterThumbnailCache } from "@/state/printer-thumbnail.cache";
import { PrusaLinkType } from "@/services/printer-api.interface";
import { PrusaBuddySimulator } from "@/services/prusa-link/testing/prusa-buddy-simulator";
import {
  createTrackingHarness,
  silentLoggerFactory,
  type TrackingHarness,
} from "@/services/prusa-link/testing/test-harness";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe("PrinterFirmwareCache — failure entries get a short TTL (fail-open window is bounded)", () => {
  it("expires a failed fetch after FAILURE_TTL but keeps a successful entry for the long TTL", async () => {
    const printerCache = {
      getCachedPrinterOrThrowAsync: async () => ({ printerType: PrusaLinkType, enabled: true }),
    } as any;
    const printerApiFactory = {
      getById: () => ({
        getVersionInfo: async () => {
          throw new Error("ECONNRESET");
        },
      }),
    } as any;
    const cache = new PrinterFirmwareCache(silentLoggerFactory, printerCache, printerApiFactory, new EventEmitter2());

    // A failed fetch fails open and is cached...
    const info = await cache.getOrFetch(1);
    expect(info.supportsBgcode).toBeNull();
    expect(cache.getCachedInfoSync(1)).not.toBeNull();

    // ...but only briefly: back-date it past the 30s failure TTL → re-probe needed.
    (cache as any).entries.get(1).fetchedAt = Date.now() - 31_000;
    expect(cache.getCachedInfoSync(1)).toBeNull();

    // A successful entry the same age is still fresh (1h model TTL).
    (cache as any).entries.set(2, {
      info: { model: "XL", supportsBgcode: true, raw: null },
      fetchedAt: Date.now() - 31_000,
      isFailure: false,
    });
    expect(cache.getCachedInfoSync(2)?.model).toBe("XL");
  });
});

describe("PrinterThumbnailCache — pruned on printer delete", () => {
  it("drops the cached thumbnail when its printer is deleted (no leak / no stale image)", async () => {
    const emitter = new EventEmitter2();
    const cache = new PrinterThumbnailCache(silentLoggerFactory, {} as any, {} as any, {} as any, emitter);

    await (cache as any).setKeyValue(7, {
      printerId: 7,
      thumbnailBase64: "x",
      jobId: 1,
      fileName: "f",
      updatedAt: new Date(),
    });
    expect(await cache.getValue(7)).not.toBeNull();

    emitter.emit("printersDeleted", { printerIds: [7] });
    await tick();

    expect(await cache.getValue(7)).toBeUndefined();
  });
});

describe("PrinterEventsCache — cleared when a printer is disabled", () => {
  let h: TrackingHarness;
  beforeEach(async () => {
    h = await createTrackingHarness();
  });
  afterEach(async () => {
    await h.destroy();
  });

  it("clears the live snapshot + lastPollState on disable so stale telemetry isn't fanned out", async () => {
    // Printer is live and printing.
    await h.poll(new PrusaBuddySimulator().startPrint().progress(30), 1);
    expect(await h.eventsCache.getPrinterSocketEvents(1)).toBeDefined();

    // Operator disables it.
    h.eventEmitter.emit("printerUpdated", { printer: { id: 1, enabled: false } });
    await tick();

    expect(await h.eventsCache.getPrinterSocketEvents(1)).toBeUndefined();

    // lastPollState was cleared too: a later PRINTING poll is treated as a fresh
    // start edge (markStarted runs) rather than being swallowed as "no change".
    const before = (
      await h.dataSource.getRepository((await import("@/entities")).PrintJob).find({ where: { printerId: 1 } })
    ).length;
    await h.poll(new PrusaBuddySimulator().startPrint({ display: "after.bgcode" }).progress(1), 1);
    const after = (
      await h.dataSource.getRepository((await import("@/entities")).PrintJob).find({ where: { printerId: 1 } })
    ).length;
    expect(after).toBeGreaterThan(before);
  });
});
