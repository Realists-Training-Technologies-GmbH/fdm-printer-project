import { Repository, Not, IsNull } from "typeorm";
import { PrintJob } from "@/entities/print-job.entity";
import { Printer } from "@/entities/printer.entity";
import EventEmitter2 from "eventemitter2";
import type { ILoggerFactory } from "@/handlers/logger-factory";
import { TypeormService } from "@/services/typeorm/typeorm.service";
import { LoggerService } from "@/handlers/logger";
import { PrinterApiFactory } from "@/services/printer-api.factory";
import { FileStorageService } from "@/services/file-storage.service";
import { PrinterSocketStore } from "@/state/printer-socket.store";
import { SOCKET_STATE } from "@/shared/dtos/socket-state.type";
import { API_STATE } from "@/shared/dtos/api-state.type";
import { PrinterMaintenanceLogService } from "@/services/orm/printer-maintenance-log.service";
import { BadRequestException } from "@/exceptions/runtime.exceptions";
import { uploadProgressEvent } from "@/constants/event.constants";
import { v4 as uuidv4 } from "uuid";
import type { AxiosProgressEvent } from "axios";

export interface QueueUploadProgress {
  printerId: number;
  jobId: number;
  fileName: string;
  // 0-1 (axios progress). Null when the printer's server hasn't sent any
  // bytes yet (initial connection / digest-auth dance) — UI should treat
  // null as "transfer starting".
  progress: number | null;
  loaded: number;
  total: number | null;
}

// Subfolder on the printer's own storage where File-Storage prints are uploaded.
// Keeps print copies out of the printer's root and lets us clean them up: the
// whole folder is swept right before the next print is uploaded (deleting at
// completion time is unreliable on PrusaLink, which keeps the just-finished
// file "selected" and answers 409 until the user dismisses it). Sweeping the
// folder rather than tracking filenames in memory also reclaims orphans left
// behind by a server restart.
export const PRINTER_TEMP_FOLDER = "prusahero-temp";

export interface QueuedJob {
  id: number;
  fileName: string;
  queuePosition: number;
  status: string;
  estimatedTimeSeconds?: number;
  filamentGrams?: number | number[];
  createdAt: Date;
  // Surfaced so the UI can render the next-up item richly (thumbnail
  // preview, layer/filament metadata) without an extra round-trip per
  // queue row.
  fileStorageId?: string | null;
  // Set when the job points at a file living on the printer's USB
  // storage (not in File Storage). The UI uses these to fetch a
  // firmware-side thumbnail instead of the file-storage one.
  usbFilePath?: string | null;
  usbDisplayName?: string | null;
  fileFormat?: string | null;
  fileSize?: number | null;
  thumbnails?: Array<{ index: number; width: number; height: number; format: string; size: number }>;
  layerHeight?: number | null;
  totalLayers?: number | null;
  printerModel?: string | null;
  filamentType?: string | null;
}

export interface IPrintQueueService {
  addToQueue(printerId: number, jobId: number, position?: number): Promise<void>;

  removeFromQueue(jobId: number): Promise<void>;

  getQueue(printerId: number): Promise<QueuedJob[]>;

  getGlobalQueuePaged(page: number, pageSize: number): Promise<[PrintJob[], number]>;

  getNextInQueue(printerId: number): Promise<PrintJob | null>;

  reorderQueue(printerId: number, jobIds: number[]): Promise<void>;

  clearQueue(printerId: number): Promise<void>;

  processQueue(printerId: number): Promise<PrintJob | null>;

  resetStrandedDispatches(): Promise<number>;

  /** Snapshot of in-flight queue uploads keyed by printerId. */
  getActiveUploads(): Record<number, QueueUploadProgress>;
}

/**
 * Simplified service for managing print job queues per printer
 */
export class PrintQueueService implements IPrintQueueService {
  printJobRepository: Repository<PrintJob>;
  printerRepository: Repository<Printer>;
  eventEmitter2: EventEmitter2;
  private readonly logger: LoggerService;
  // Live upload progress keyed by printerId. Populated by
  // `dispatchToPrinter` while the PUT/POST is streaming and cleared in a
  // `finally` so a stuck connection can't leave a phantom entry. Read
  // through `getActiveUploads()` by SocketIoTask and broadcast in the
  // periodic update payload — that's how the grid tile's "Transferring…"
  // progress bar gets its data.
  private readonly uploadProgressByPrinterId = new Map<number, QueueUploadProgress>();

  constructor(
    loggerFactory: ILoggerFactory,
    typeormService: TypeormService,
    eventEmitter2: EventEmitter2,
    private readonly printerApiFactory: PrinterApiFactory,
    private readonly fileStorageService: FileStorageService,
    private readonly printerSocketStore: PrinterSocketStore,
    private readonly printerMaintenanceLogService: PrinterMaintenanceLogService,
  ) {
    this.printJobRepository = typeormService.getDataSource().getRepository(PrintJob);
    this.printerRepository = typeormService.getDataSource().getRepository(Printer);
    this.eventEmitter2 = eventEmitter2;
    this.logger = loggerFactory(PrintQueueService.name);

    // Auto-advance the queue: when the active job reaches a terminal state, try
    // to dispatch the next queued job. Best-effort — the printer might be
    // offline or there may be nothing queued, so failures are only logged.
    const advance = (event: { printerId?: number }) => {
      const printerId = event?.printerId;
      if (!printerId) return;
      this.processQueue(printerId).catch((error) => {
        this.logger.debug(
          `Queue auto-advance skipped for printer ${printerId}: ${error instanceof Error ? error.message : error}`,
        );
      });
    };
    this.eventEmitter2.on("printJob.completed", advance);
    this.eventEmitter2.on("printJob.failed", advance);
    this.eventEmitter2.on("printJob.cancelled", advance);
  }

  private isPrinterConnected(printerId: number): { connected: boolean; reason?: string } {
    const socket = this.printerSocketStore.getPrinterSocket(printerId);

    if (!socket) {
      return { connected: false, reason: "No socket connection found" };
    }

    const socketState = socket.socketState;
    const apiState = socket.apiState;

    if (socketState !== SOCKET_STATE.opened && socketState !== SOCKET_STATE.authenticated) {
      return { connected: false, reason: `Socket not connected (state: ${socketState})` };
    }

    if (apiState !== API_STATE.responding) {
      return { connected: false, reason: `Printer not responding (API state: ${apiState})` };
    }

    return { connected: true };
  }

  async addToQueue(printerId: number, jobId: number, position?: number): Promise<void> {
    const job = await this.printJobRepository.findOne({ where: { id: jobId } });
    if (!job) {
      throw new Error(`Print job ${jobId} not found`);
    }

    this.ensurePrinterAssignment(job, printerId);
    await this.ensurePrinterNotInMaintenance(printerId);

    if (position === undefined || position === null) {
      const maxPosition = await this.getMaxQueuePosition(printerId);
      job.queuePosition = (maxPosition ?? -1) + 1;
    } else {
      await this.shiftQueuePositions(printerId, position);
      job.queuePosition = position;
    }

    job.status = "QUEUED";
    await this.printJobRepository.save(job);

    this.logger.log(`Added job ${jobId} to printer ${printerId} queue at position ${job.queuePosition}`);
    this.eventEmitter2.emit("printQueue.jobAdded", {
      printerId,
      jobId,
      position: job.queuePosition,
    });
  }

  async removeFromQueue(jobId: number): Promise<void> {
    const job = await this.printJobRepository.findOne({ where: { id: jobId } });
    if (!job) {
      throw new Error(`Print job ${jobId} not found`);
    }

    const printerId = job.printerId;
    const oldPosition = job.queuePosition;

    job.queuePosition = null;
    if (job.status === "QUEUED") {
      job.status = "PENDING";
    }
    await this.printJobRepository.save(job);

    if (oldPosition !== null && printerId) {
      await this.compactQueuePositions(printerId, oldPosition);
    }

    this.logger.log(`Removed job ${jobId} from queue`);
    this.eventEmitter2.emit("printQueue.jobRemoved", {
      printerId,
      jobId,
    });
  }

  async getQueue(printerId: number): Promise<QueuedJob[]> {
    // Include STARTING so the queue UI keeps showing the job that's currently
    // mid-upload as "transferring" instead of vanishing the moment processQueue
    // flips its status. Both QUEUED and STARTING jobs still carry queuePosition
    // until the upload completes.
    const jobs = await this.printJobRepository.find({
      where: [
        { printerId, status: "QUEUED", queuePosition: Not(IsNull()) },
        { printerId, status: "STARTING", queuePosition: Not(IsNull()) },
      ],
      order: { queuePosition: "ASC" },
    });

    return jobs.map((j) => {
      const md = (j.metadata as any) ?? {};
      const thumbnails = Array.isArray(md._thumbnails)
        ? md._thumbnails.map((t: any) => ({
            index: t.index,
            width: t.width,
            height: t.height,
            format: t.format,
            size: t.size,
          }))
        : Array.isArray((j as any).thumbnails)
          ? (j as any).thumbnails
          : undefined;
      return {
        id: j.id,
        fileName: j.fileName,
        queuePosition: j.queuePosition!,
        status: j.status,
        estimatedTimeSeconds: md.gcodePrintTimeSeconds,
        filamentGrams: md.filamentUsedGrams,
        createdAt: j.createdAt,
        // Extra fields so the UI can render a "next up" hero card
        // (thumbnail + metadata) without per-row fetches.
        fileStorageId: j.fileStorageId ?? null,
        usbFilePath: (j as any).usbFilePath ?? null,
        usbDisplayName: (j as any).usbDisplayName ?? null,
        fileFormat: j.fileFormat ?? null,
        fileSize: j.fileSize ?? null,
        thumbnails,
        layerHeight: md.layerHeight ?? null,
        totalLayers: md.totalLayers ?? null,
        printerModel: md.printerModel ?? null,
        filamentType: md.filamentType ?? null,
      };
    });
  }

  async getGlobalQueuePaged(page: number, pageSize: number): Promise<[PrintJob[], number]> {
    const skip = (page - 1) * pageSize;

    return await this.printJobRepository.findAndCount({
      where: { status: "QUEUED" },
      order: {
        printerId: "ASC",
        queuePosition: "ASC",
      },
      relations: ["printer"],
      take: pageSize,
      skip: skip,
    });
  }

  async getNextInQueue(printerId: number): Promise<PrintJob | null> {
    return this.printJobRepository.findOne({
      where: {
        printerId,
        status: "QUEUED",
        queuePosition: Not(IsNull()),
      },
      order: { queuePosition: "ASC" },
    });
  }

  async reorderQueue(printerId: number, jobIds: number[]): Promise<void> {
    for (let i = 0; i < jobIds.length; i++) {
      const job = await this.printJobRepository.findOne({ where: { id: jobIds[i] } });
      if (job?.printerId === printerId) {
        job.queuePosition = i;
        await this.printJobRepository.save(job);
      }
    }

    this.logger.log(`Reordered queue for printer ${printerId}`);
    this.eventEmitter2.emit("printQueue.reordered", { printerId });
  }

  /**
   * Recover stranded background dispatches at boot.
   *
   * A STARTING job represents an upload that was in flight when the server
   * stopped. The actual TCP upload died with the process, so the printer
   * never received the full file. Roll these back to QUEUED with a clear
   * statusReason so the user (or queue auto-advance) can retry.
   *
   * queuePosition is left intact so the job keeps its slot.
   */
  getActiveUploads(): Record<number, QueueUploadProgress> {
    const out: Record<number, QueueUploadProgress> = {};
    for (const [printerId, progress] of this.uploadProgressByPrinterId.entries()) {
      out[printerId] = progress;
    }
    return out;
  }

  async resetStrandedDispatches(): Promise<number> {
    const stranded = await this.printJobRepository.find({ where: { status: "STARTING" } });
    if (stranded.length === 0) return 0;

    for (const job of stranded) {
      job.status = "QUEUED";
      job.statusReason = "Upload interrupted by server restart — requeued for retry.";
      await this.printJobRepository.save(job);
      this.logger.warn(`Reset stranded STARTING job ${job.id} (printer ${job.printerId}) → QUEUED`);
    }
    return stranded.length;
  }

  async clearQueue(printerId: number): Promise<void> {
    const jobs = await this.printJobRepository.find({
      where: {
        printerId,
        status: "QUEUED",
      },
    });

    for (const job of jobs) {
      job.status = "PENDING";
      job.queuePosition = null;
      await this.printJobRepository.save(job);
    }

    this.logger.log(`Cleared queue for printer ${printerId} (${jobs.length} jobs)`);
    this.eventEmitter2.emit("printQueue.cleared", { printerId });
  }

  async processQueue(printerId: number): Promise<PrintJob | null> {
    const nextJob = await this.getNextInQueue(printerId);

    if (!nextJob) {
      this.logger.log(`No jobs in queue for printer ${printerId}`);
      return null;
    }

    // Refuse to submit when the printer isn't actually reachable — the
    // submission would fail mid-upload and flip the job to FAILED, forcing the
    // user to requeue. Better to leave the job in queue and surface the reason.
    const connectivity = this.isPrinterConnected(printerId);
    if (!connectivity.connected) {
      throw new BadRequestException(
        `Cannot process queue: printer ${printerId} is not ready. ${connectivity.reason ?? ""}`.trim(),
      );
    }

    this.logger.log(`Processing queue: next job is ${nextJob.id} (${nextJob.fileName})`);

    // Actually push the file to the printer and start it. Previous behaviour
    // only fired an event with no listener, so "Process next" was a silent
    // no-op for the user.
    await this.submitToPrinter(printerId, nextJob.id);

    return nextJob;
  }

  private async ensurePrinterNotInMaintenance(printerId: number): Promise<void> {
    const inMaintenance = await this.printerMaintenanceLogService.hasActiveByPrinterId(printerId);
    if (inMaintenance) {
      throw new BadRequestException(
        `Printer ${printerId} has pending maintenance and cannot accept print jobs. Complete the maintenance first.`,
      );
    }
  }

  // Refuse to dispatch a second print to a printer that's already busy. The
  // observer (printer-events.cache) keeps an active job at PRINTING/PAUSED, so
  // a busy printer means starting another print would either be rejected by the
  // firmware or silently clobber the running job's tracking. STARTING is
  // included because that's our own "upload in flight" marker — the printer is
  // already receiving bytes and a second dispatch would collide on the wire.
  private async ensurePrinterIdle(printerId: number, exceptJobId: number): Promise<void> {
    const active = await this.printJobRepository.findOne({
      where: [
        { printerId, status: "PRINTING" },
        { printerId, status: "PAUSED" },
        { printerId, status: "STARTING" },
      ],
      order: { startedAt: "DESC" },
    });

    if (active && active.id !== exceptJobId) {
      throw new BadRequestException(
        `Printer ${printerId} is busy with job ${active.id} (${active.status}) and cannot start another print.`,
      );
    }
  }

  private ensurePrinterAssignment(job: PrintJob, printerId: number): void {
    if (!job.printerId) {
      job.printerId = printerId;
    } else if (job.printerId !== printerId) {
      throw new Error(`Job ${job.id} belongs to printer ${job.printerId}, cannot submit to printer ${printerId}`);
    }
  }

  private async getMaxQueuePosition(printerId: number): Promise<number | null> {
    const result = await this.printJobRepository
      .createQueryBuilder("job")
      .select("MAX(job.queuePosition)", "max")
      .where("job.printerId = :printerId", { printerId })
      .getRawOne();

    return result?.max ?? null;
  }

  private async shiftQueuePositions(printerId: number, fromPosition: number): Promise<void> {
    await this.printJobRepository
      .createQueryBuilder()
      .update(PrintJob)
      .set({ queuePosition: () => "queuePosition + 1" })
      .where("printerId = :printerId", { printerId })
      .andWhere("queuePosition >= :fromPosition", { fromPosition })
      .execute();
  }

  private async compactQueuePositions(printerId: number, removedPosition: number): Promise<void> {
    await this.printJobRepository
      .createQueryBuilder()
      .update(PrintJob)
      .set({ queuePosition: () => "queuePosition - 1" })
      .where("printerId = :printerId", { printerId })
      .andWhere("queuePosition > :removedPosition", { removedPosition })
      .execute();
  }

  async submitToPrinter(printerId: number, jobId: number): Promise<void> {
    const job = await this.printJobRepository.findOne({ where: { id: jobId } });

    if (!job) {
      throw new Error(`Print job ${jobId} not found`);
    }

    this.ensurePrinterAssignment(job, printerId);
    await this.ensurePrinterNotInMaintenance(printerId);
    await this.ensurePrinterIdle(printerId, jobId);

    // Flip status to STARTING synchronously so:
    //  - ensurePrinterIdle on a concurrent "process next" sees the printer busy
    //  - the queue UI shows "transferring..." instead of plain "QUEUED"
    //  - server restart / boot sweeper can find stuck uploads to recover
    // queuePosition stays set until the upload actually succeeds; the row only
    // leaves the queue once we know the firmware accepted it.
    job.status = "STARTING";
    job.statusReason = null;
    await this.printJobRepository.save(job);

    this.logger.log(
      `Dispatching job ${jobId} (${job.fileName}) to printer ${printerId} — upload running in background`,
    );
    this.eventEmitter2.emit("printQueue.jobSubmitting", { printerId, jobId });

    // Detach the actual upload+start from the HTTP request that triggered it.
    // PrusaLink uploads of 100+ MB take minutes; if the user closes/refreshes
    // the page, we don't want the dispatch to die with the browser request.
    // The background promise updates the job row on success/failure and emits
    // events so the queue UI can reflect the outcome via Socket.IO.
    void this.dispatchInBackground(printerId, jobId);
  }

  private async dispatchInBackground(printerId: number, jobId: number): Promise<void> {
    let job = await this.printJobRepository.findOne({ where: { id: jobId } });
    if (!job || job.status !== "STARTING") {
      this.logger.warn(`Background dispatch for job ${jobId} skipped: status is ${job?.status ?? "missing"}`);
      return;
    }

    try {
      await this.dispatchToPrinter(printerId, job);

      // Re-read the row — the poll observer may have already promoted it to
      // PRINTING based on the printer's own status. Don't clobber that, but
      // do clear queuePosition so the row leaves the visible queue.
      job = (await this.printJobRepository.findOne({ where: { id: jobId } })) ?? job;
      if (job.queuePosition !== null) {
        const oldPosition = job.queuePosition;
        job.queuePosition = null;
        await this.compactQueuePositions(printerId, oldPosition);
      }
      if (job.status === "STARTING") {
        job.status = "PRINTING";
        job.startedAt = new Date();
      }
      job.statusReason = null;
      await this.printJobRepository.save(job);

      this.logger.log(`Successfully submitted job ${jobId} to printer ${printerId}`);
      this.eventEmitter2.emit("printQueue.jobSubmitted", { printerId, jobId });
    } catch (error) {
      // Re-read and roll back to QUEUED so the next "process next" (or
      // auto-advance) can retry. queuePosition is left intact so the job
      // stays in its slot.
      job = (await this.printJobRepository.findOne({ where: { id: jobId } })) ?? job;
      job.status = "QUEUED";
      job.statusReason = `Print submission failed: ${error instanceof Error ? error.message : "Unknown error"}`;
      await this.printJobRepository.save(job);
      this.logger.error(`Failed to submit job ${jobId} to printer ${printerId} - left in queue for retry`, error);
      this.eventEmitter2.emit("printQueue.jobSubmissionFailed", {
        printerId,
        jobId,
        reason: job.statusReason,
      });
    }
  }

  private async dispatchToPrinter(printerId: number, job: PrintJob): Promise<void> {
    const printerApi = this.printerApiFactory.getById(printerId);
    const fileName = job.fileName;

    if (job.usbFilePath) {
      // File already lives on the printer's storage — just tell the firmware
      // to start it. Mirrors the per-segment encoding the legacy USB-print
      // controller uses so PrusaLink/OctoPrint accept paths with spaces.
      const encodedPath = job.usbFilePath.split("/").map(encodeURIComponent).join("/");
      this.logger.log(`Starting print of USB file ${job.usbFilePath} on printer ${printerId}`);
      await printerApi.startPrint(encodedPath);
    } else if (job.fileStorageId) {
      // Clean up temp files from this printer's previous print(s) before we
      // upload the next one — by now the printer has moved on so they're no
      // longer "selected"/in use and the delete succeeds.
      await this.cleanupTempFolder(printerApi, printerId);

      // Ensure the temp folder exists (no-op if the printer type or firmware
      // doesn't support folder creation).
      if (typeof printerApi.createFolder === "function") {
        try {
          await printerApi.createFolder(PRINTER_TEMP_FOLDER);
        } catch (e) {
          this.logger.debug(
            `Could not pre-create temp folder on printer ${printerId} (continuing): ${
              e instanceof Error ? e.message : e
            }`,
          );
        }
      }

      const fileSize = this.fileStorageService.getFileSize(job.fileStorageId);
      const fileStream = this.fileStorageService.readFileStream(job.fileStorageId);

      // Generate a per-dispatch correlation token. PrusaLinkApi emits
      // `upload.progress.${token}` events with axios's progress payload
      // each time bytes flush; we mirror that into the per-printer map so
      // the next periodic socketio update can surface a transfer bar in
      // the grid tile.
      const uploadToken = `queue-${job.id}-${uuidv4()}`;
      const onProgress = (_token: string, event: AxiosProgressEvent) => {
        this.uploadProgressByPrinterId.set(printerId, {
          printerId,
          jobId: job.id,
          fileName,
          progress: event.progress ?? null,
          loaded: event.loaded,
          total: event.total ?? null,
        });
      };
      this.eventEmitter2.on(uploadProgressEvent(uploadToken), onProgress);

      this.logger.log(`Uploading file ${fileName} to printer ${printerId} (temp folder) and starting print`);
      try {
        await printerApi.uploadFile({
          stream: fileStream,
          fileName,
          contentLength: fileSize,
          startPrint: true,
          targetPath: PRINTER_TEMP_FOLDER,
          uploadToken,
        });
      } finally {
        // Always detach the listener AND clear the cache slot so a failed
        // upload doesn't leave a stale "53%" indicator on the tile.
        this.eventEmitter2.off(uploadProgressEvent(uploadToken), onProgress);
        this.uploadProgressByPrinterId.delete(printerId);
      }
    } else {
      throw new Error(`Job ${job.id} has neither fileStorageId nor usbFilePath - cannot submit to printer`);
    }

    this.logger.log(`Dispatched job ${job.id} to printer ${printerId}`);
  }

  /**
   * Best-effort sweep of the printer's temp folder before a new File-Storage
   * print. Deletes everything left in `PRINTER_TEMP_FOLDER` (the previous
   * print's file plus any orphans from an earlier server restart). Never throws
   * — cleanup must not block the new print; a file that's still "in use" (409)
   * is simply left for the next sweep.
   */
  private async cleanupTempFolder(
    printerApi: {
      getFiles(recursive?: boolean, startDir?: string): Promise<{ files: Array<{ path: string }> }>;
      deleteFile(path: string): Promise<void>;
    },
    printerId: number,
  ) {
    let files: Array<{ path: string }>;
    try {
      const listing = await printerApi.getFiles(false, PRINTER_TEMP_FOLDER);
      files = listing?.files ?? [];
    } catch (e) {
      // Folder doesn't exist yet, or the printer is momentarily unreachable —
      // nothing to clean, proceed with the upload.
      this.logger.debug(
        `Could not list temp folder on printer ${printerId} (continuing): ${e instanceof Error ? e.message : e}`,
      );
      return;
    }

    for (const file of files) {
      try {
        await printerApi.deleteFile(file.path);
        this.logger.log(`Deleted leftover temp print file ${file.path} on printer ${printerId}`);
      } catch (e) {
        this.logger.warn(
          `Could not delete temp print file ${file.path} on printer ${printerId} (will retry next print): ${
            e instanceof Error ? e.message : e
          }`,
        );
      }
    }
  }
}
