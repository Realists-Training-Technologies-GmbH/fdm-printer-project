import { SocketIoGateway, IO_MESSAGES } from "@/state/socket-io.gateway";
import { socketIoConnectedEvent } from "@/constants/event.constants";
import { PrinterSocketStore } from "@/state/printer-socket.store";
import { PrinterEventsCache } from "@/state/printer-events.cache";
import { FloorStore } from "@/state/floor.store";
import { FileUploadTrackerCache } from "@/state/file-upload-tracker.cache";
import EventEmitter2 from "eventemitter2";
import { PrinterCache } from "@/state/printer.cache";
import { LoggerService } from "@/handlers/logger";
import type { ILoggerFactory } from "@/handlers/logger-factory";
import { PrintQueueService } from "@/services/print-queue.service";

export class SocketIoTask {
  logger: LoggerService;

  constructor(
    loggerFactory: ILoggerFactory,
    private readonly socketIoGateway: SocketIoGateway,
    private readonly floorStore: FloorStore,
    private readonly printerSocketStore: PrinterSocketStore,
    private readonly printerEventsCache: PrinterEventsCache,
    private readonly printerCache: PrinterCache,
    private readonly fileUploadTrackerCache: FileUploadTrackerCache,
    private readonly eventEmitter2: EventEmitter2,
    private readonly printQueueService: PrintQueueService,
  ) {
    this.logger = loggerFactory(SocketIoTask.name);

    this.eventEmitter2.on(socketIoConnectedEvent, async () => {
      await this.sendUpdate();
    });

    // Bridge selected internal events to socket.io so the client can show
    // toasts and invalidate per-printer queries reactively. These fire on
    // discrete transitions (job dispatched, dispatch failed, thumbnail
    // updated), so broadcasting them out-of-band is cheaper than fattening
    // every periodic `Update` payload — and the client wouldn't notice
    // queue state from a periodic snapshot if the user is on a different
    // page.
    this.eventEmitter2.on("printQueue.jobSubmitted", (data) =>
      this.socketIoGateway.send(IO_MESSAGES.QueueEvent, { kind: "submitted", ...data }),
    );
    this.eventEmitter2.on("printQueue.jobSubmissionFailed", (data) =>
      this.socketIoGateway.send(IO_MESSAGES.QueueEvent, { kind: "failed", ...data }),
    );
    this.eventEmitter2.on("printer.thumbnailChanged", (data) =>
      this.socketIoGateway.send(IO_MESSAGES.PrinterThumbnailChanged, data),
    );

    // Print-lifecycle terminal transitions — fanned out so the client can
    // raise a browser notification when an unattended print finishes. The
    // raw payloads from PrintJobService already carry `jobId`, `printerId`,
    // `fileName`, plus per-kind fields (`actualTimeSeconds` for completed,
    // `reason` for failed). The client just needs the kind discriminator,
    // hence the spread + literal `kind:` here.
    this.eventEmitter2.on("printJob.completed", (data) =>
      this.socketIoGateway.send(IO_MESSAGES.PrintJobEvent, { kind: "completed", ...data }),
    );
    this.eventEmitter2.on("printJob.failed", (data) =>
      this.socketIoGateway.send(IO_MESSAGES.PrintJobEvent, { kind: "failed", ...data }),
    );
    this.eventEmitter2.on("printJob.cancelled", (data) =>
      this.socketIoGateway.send(IO_MESSAGES.PrintJobEvent, { kind: "cancelled", ...data }),
    );

    // Intake inbox changed — a file arrived via the API or an item was
    // resolved. The client refreshes its list + menu badge, and toasts new
    // arrivals. Payload carries `kind` ("created" | "resolved") and the id.
    this.eventEmitter2.on("intake.changed", (data) => this.socketIoGateway.send(IO_MESSAGES.IntakeEvent, { ...data }));
  }

  async run() {
    await this.sendUpdate();
  }

  async sendUpdate() {
    const floors = await this.floorStore.listCache();
    const printers = await this.printerCache.listCachedPrinters(true);
    const socketStates = this.printerSocketStore.getSocketStatesById();
    const printerEvents = await this.printerEventsCache.getAllKeyValues();
    const trackedUploads = this.fileUploadTrackerCache.getUploads();

    const socketIoData = {
      printers,
      floors,
      socketStates,
      printerEvents,
      trackedUploads,
      // Queue upload progress keyed by printerId. Mutated by
      // PrintQueueService while a dispatch's PUT is streaming; included on
      // every periodic update so the tile can render a "Transferring…"
      // bar without an extra round-trip per second.
      queueUploads: this.printQueueService.getActiveUploads(),
    };

    this.socketIoGateway.send(IO_MESSAGES.Update, socketIoData);
  }
}
