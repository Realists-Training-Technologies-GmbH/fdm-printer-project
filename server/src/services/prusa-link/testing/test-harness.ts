import "reflect-metadata";
import { Readable } from "node:stream";
import { DataSource } from "typeorm";
import EventEmitter2 from "eventemitter2";
import {
  User,
  CameraStream,
  Floor,
  FloorPosition,
  Printer,
  Role,
  UserRole,
  Settings,
  RefreshToken,
  PrinterTag,
  Tag,
  PrintJob,
  PrinterMaintenanceLog,
  FileStorageFolder,
  IntakeItem,
} from "@/entities";
import { PrintJobService } from "@/services/orm/print-job.service";
import { PrintQueueService } from "@/services/print-queue.service";
import { PrinterEventsCache } from "@/state/printer-events.cache";
import type { ILoggerFactory } from "@/handlers/logger-factory";
import { PrusaBuddySimulator } from "@/services/prusa-link/testing/prusa-buddy-simulator";
import { normalizePrusaLinkPoll } from "@/services/prusa-link/utils/normalize-poll";
import { PrusaLinkType } from "@/services/printer-api.interface";

// A no-op logger factory — any method call resolves to a silent function.
export const silentLoggerFactory: ILoggerFactory = (() =>
  new Proxy(
    {},
    {
      get: () => () => {},
    },
  )) as unknown as ILoggerFactory;

/**
 * Configurable fake of the per-printer IPrinterApi for dispatch tests. Records
 * every call and lets a test drive upload/start outcomes (success, transient
 * 5xx, permanent error, user cancel) without real HTTP.
 */
export class FakePrinterApi {
  calls = {
    startPrint: [] as string[],
    uploadFile: [] as any[],
    createFolder: [] as string[],
    getFiles: [] as Array<{ recursive?: boolean; startDir?: string }>,
    deleteFile: [] as string[],
  };
  /** Files the temp-folder sweep should find (default: none). */
  tempFiles: Array<{ path: string }> = [];
  /** Override to make uploadFile succeed/fail/hang. Receives the upload input. */
  uploadBehavior: (input: any) => Promise<void> = async () => {};
  /** Override to make startPrint succeed/fail. */
  startPrintBehavior: (path: string) => Promise<void> = async () => {};

  async startPrint(path: string): Promise<void> {
    this.calls.startPrint.push(path);
    await this.startPrintBehavior(path);
  }
  async uploadFile(input: any): Promise<void> {
    this.calls.uploadFile.push(input);
    await this.uploadBehavior(input);
  }
  async createFolder(path: string): Promise<void> {
    this.calls.createFolder.push(path);
  }
  async getFiles(recursive?: boolean, startDir?: string): Promise<{ files: Array<{ path: string }> }> {
    this.calls.getFiles.push({ recursive, startDir });
    return { files: this.tempFiles };
  }
  async deleteFile(path: string): Promise<void> {
    this.calls.deleteFile.push(path);
  }
}

export interface QueueServiceOptions {
  /** The fake IPrinterApi returned by printerApiFactory.getById for any printer. */
  printerApi?: FakePrinterApi;
  /** File size reported by the stub FileStorageService.getFileSize. */
  fileSize?: number;
}

/**
 * Spin up an in-memory SQLite DataSource with the full schema (synchronize:
 * true). Isolated per call so tests can't bleed into each other.
 */
export async function createInMemoryDataSource(): Promise<DataSource> {
  const ds = new DataSource({
    type: "better-sqlite3",
    database: ":memory:",
    synchronize: true,
    logging: false,
    entities: [
      Floor,
      FloorPosition,
      Printer,
      Settings,
      User,
      CameraStream,
      Role,
      RefreshToken,
      UserRole,
      Tag,
      PrinterTag,
      PrintJob,
      PrinterMaintenanceLog,
      FileStorageFolder,
      IntakeItem,
    ],
  });
  await ds.initialize();
  // Tests exercise job-tracking logic in isolation, not referential integrity.
  // Disable FK enforcement so a PrintJob can reference a printerId without
  // seeding a full Printer row (and its transitive required relations).
  await ds.query("PRAGMA foreign_keys = OFF");
  return ds;
}

export interface TrackingHarness {
  dataSource: DataSource;
  eventEmitter: EventEmitter2;
  printJobService: PrintJobService;
  eventsCache: PrinterEventsCache;
  /** Captured printJob.* event names in order, for asserting transitions fired. */
  emittedJobEvents: string[];
  /** Feed one firmware poll through the real normalize → observer path. */
  poll(sim: PrusaBuddySimulator, printerId: number): Promise<void>;
  /**
   * Seed the events cache's live `current` snapshot WITHOUT running the
   * observer transitions — for testing consumers (e.g. `ensurePrinterIdle`)
   * that read the live state independently of the job lifecycle.
   */
  seedLiveState(sim: PrusaBuddySimulator, printerId: number): Promise<void>;
  /** Build a real PrintQueueService sharing this harness's DB + events cache. */
  makePrintQueueService(opts?: QueueServiceOptions): PrintQueueService;
  destroy(): Promise<void>;
}

/**
 * Build a tracking harness wiring the REAL `PrintJobService` and
 * `PrinterEventsCache` over an in-memory DB. Dependencies the observer doesn't
 * exercise for job tracking (printer name lookup, thumbnail cache) are stubbed.
 */
export async function createTrackingHarness(printerName = "XL-1"): Promise<TrackingHarness> {
  const dataSource = await createInMemoryDataSource();
  const eventEmitter = new EventEmitter2();
  const typeormService = { getDataSource: () => dataSource } as any;

  const printJobService = new PrintJobService(silentLoggerFactory, typeormService, eventEmitter);

  const printerCache = { getValue: async () => ({ name: printerName }) } as any;
  const printerThumbnailCache = {
    handleJobStarted: async () => {},
    handleJobCompleted: async () => {},
  } as any;

  const eventsCache = new PrinterEventsCache(
    eventEmitter,
    silentLoggerFactory,
    printJobService,
    printerCache,
    printerThumbnailCache,
  );

  const emittedJobEvents: string[] = [];
  for (const ev of ["started", "completed", "failed", "cancelled", "paused", "resumed", "progress"]) {
    eventEmitter.on(`printJob.${ev}`, () => emittedJobEvents.push(ev));
  }

  return {
    dataSource,
    eventEmitter,
    printJobService,
    eventsCache,
    emittedJobEvents,
    async poll(sim: PrusaBuddySimulator, printerId: number) {
      const payload = normalizePrusaLinkPoll(
        sim.getPrinterStateResponse(),
        sim.getJobStateResponse(),
        sim.getStatusResponse(),
      );
      // Call the observer the same way the event subscription would, but
      // directly (deterministic, no wildcard-emitter dependency).
      await (eventsCache as any).onPrusaLinkPollMessage({
        event: "current",
        payload,
        printerId,
        printerType: PrusaLinkType,
      });
    },
    async seedLiveState(sim: PrusaBuddySimulator, printerId: number) {
      const payload = normalizePrusaLinkPoll(
        sim.getPrinterStateResponse(),
        sim.getJobStateResponse(),
        sim.getStatusResponse(),
      );
      await eventsCache.setEvent(printerId, "current", payload);
    },
    makePrintQueueService(opts: QueueServiceOptions = {}) {
      const printerApi = opts.printerApi ?? new FakePrinterApi();
      const fileSize = opts.fileSize ?? 1024;
      const printerApiFactory = { getById: () => printerApi } as any;
      const fileStorageService = {
        getFileSize: () => fileSize,
        readFileStream: () => Readable.from([Buffer.alloc(fileSize)]),
      } as any;
      return new PrintQueueService(
        silentLoggerFactory,
        typeormService,
        eventEmitter,
        printerApiFactory,
        fileStorageService,
        {} as any, // printerSocketStore — unused by these tests
        { hasActiveByPrinterId: async () => false } as any, // maintenance log
        eventsCache,
      );
    },
    async destroy() {
      await dataSource.destroy();
    },
  };
}
