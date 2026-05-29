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

  /** Abort an in-flight dispatch for a printer. Returns false when none was running. */
  cancelDispatch(printerId: number): boolean;
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
  // AbortController per in-flight dispatch, keyed by printerId. Lets a
  // user cancel a stuck upload mid-stream from the tile instead of
  // waiting for the TCP timeout. The `finally` in `dispatchToPrinter`
  // deletes the entry whether the upload succeeded, failed, or was
  // aborted, so a stale controller can't accidentally cancel the *next*
  // job dispatched to the same printer.
  private readonly dispatchAbortersByPrinterId = new Map<number, AbortController>();

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

  cancelDispatch(printerId: number): boolean {
    const controller = this.dispatchAbortersByPrinterId.get(printerId);
    if (!controller) return false;
    controller.abort();
    this.logger.log(`Cancelled in-flight dispatch for printer ${printerId} on user request`);
    return true;
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

    // Single cancellation handle shared across all retry attempts. If the
    // user cancels, every in-flight axios request unwinds at once and the
    // retry loop short-circuits in the catch (CanceledError → !transient).
    const aborter = new AbortController();
    this.dispatchAbortersByPrinterId.set(printerId, aborter);

    try {
      // Retry transient failures — network blips, 5xx, the printer's HTTP
      // server momentarily dropping during high load — without the user
      // having to press "process next" again. Backoff schedule is short
      // and bounded; permanent errors (4xx, 507 Insufficient Storage,
      // explicit cancels) bypass the loop and bubble straight out.
      const RETRY_DELAYS_MS = [2000, 5000];
      let lastError: unknown = null;
      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
        try {
          await this.dispatchToPrinter(printerId, job, aborter.signal);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          if (!this.isTransientDispatchError(error) || attempt === RETRY_DELAYS_MS.length) {
            throw error;
          }
          const delay = RETRY_DELAYS_MS[attempt];
          this.logger.warn(
            `Dispatch attempt ${attempt + 1} for job ${jobId} on printer ${printerId} failed transiently ` +
              `(${error instanceof Error ? error.message : "unknown"}). Retrying in ${delay}ms.`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
      if (lastError) throw lastError;

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

      // Distinguish user-initiated aborts from real failures — axios maps
      // an aborted request to `code === 'ERR_CANCELED'`. The job still
      // rolls back to QUEUED either way (the file didn't make it to the
      // printer), but the statusReason and the emitted event let the UI
      // show "Cancelled by user" instead of a scary stack trace.
      const wasCancelled =
        (error as { code?: string; name?: string })?.code === "ERR_CANCELED" ||
        (error as { name?: string })?.name === "CanceledError";
      if (wasCancelled) {
        job.statusReason = "Cancelled by user — upload aborted mid-transfer.";
      } else {
        job.statusReason = `Print submission failed: ${this.extractFriendlyError(error)}`;
      }
      await this.printJobRepository.save(job);
      if (wasCancelled) {
        this.logger.log(`Dispatch of job ${jobId} to printer ${printerId} cancelled by user`);
      } else {
        this.logger.error(`Failed to submit job ${jobId} to printer ${printerId} - left in queue for retry`, error);
      }
      this.eventEmitter2.emit("printQueue.jobSubmissionFailed", {
        printerId,
        jobId,
        reason: job.statusReason,
        cancelled: wasCancelled,
      });
    } finally {
      // Whether the dispatch succeeded, failed, or was aborted, the
      // controller's job is done — drop it from the map so the cancel
      // endpoint reports "no in-flight dispatch" and the next dispatch
      // creates a fresh aborter.
      this.dispatchAbortersByPrinterId.delete(printerId);
    }
  }

  /**
   * Pull a human-readable single sentence out of whatever the upload
   * pipeline threw. `ExternalServiceError` stringifies its full response
   * object — including stack — into `.message`, so naively setting
   * `statusReason = error.message` puts a wall of JSON in the operator's
   * toast (we saw this with the 507 today). Prefer the friendly `error`
   * field that PrusaLinkApi already curates for each HTTP status, then
   * fall back to `axios.response.data.error/title/message`, then to the
   * plain `error.message`. Final fallback strips JSON-ish residue so
   * even a worst-case error stays one short line.
   */
  private extractFriendlyError(error: unknown): string {
    if (!error) return "Unknown error";
    if (typeof error === "string") return error;
    const e = error as {
      error?: { error?: unknown } | string;
      message?: string;
      response?: { data?: { error?: string; title?: string; message?: string } };
    };

    // ExternalServiceError wraps the curated friendly string at `.error.error`.
    const curated = (e.error as { error?: unknown })?.error;
    if (typeof curated === "string" && curated.trim()) return curated.trim();

    // Raw axios path — the printer's response body sometimes carries a
    // ready-to-show string under `error` / `title` / `message`.
    const resp = e.response?.data;
    if (resp) {
      if (typeof resp.error === "string" && resp.error.trim()) return resp.error.trim();
      if (typeof resp.title === "string" && resp.title.trim()) return resp.title.trim();
      if (typeof resp.message === "string" && resp.message.trim()) return resp.message.trim();
    }

    // Last-resort: extract the first line of `.message` and reject things
    // that look like JSON dumps (start with `{`) so even an unexpected
    // shape doesn't paste a stack into the toast.
    const msg = (e.message ?? "").trim();
    if (!msg) return "Unknown error";
    if (msg.startsWith("{")) return "Print submission failed (see server logs for details).";
    const firstLine = msg.split(/\r?\n/)[0]!.trim();
    return firstLine || "Unknown error";
  }

  /**
   * Returns true for errors worth a quick retry: socket-level disconnects
   * and 5xx-class responses where the next attempt has a reasonable
   * chance of succeeding. Explicit cancels and 4xx (incl. 507
   * Insufficient Storage) are intentionally excluded — re-uploading
   * 120 MB to a full USB will just fail again.
   */
  private isTransientDispatchError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const e = error as { code?: string; name?: string; response?: { status?: number } };
    if (e.code === "ERR_CANCELED" || e.name === "CanceledError") return false;
    const status = e.response?.status;
    if (typeof status === "number") {
      // 502 Bad Gateway / 503 Service Unavailable / 504 Gateway Timeout —
      // the printer's HTTP server is overloaded but probably recovers.
      return status === 502 || status === 503 || status === 504;
    }
    // Network-level errors with no HTTP response at all.
    return (
      e.code === "ECONNRESET" ||
      e.code === "ETIMEDOUT" ||
      e.code === "ENOTFOUND" ||
      e.code === "ECONNABORTED" ||
      e.code === "EAI_AGAIN"
    );
  }

  private async dispatchToPrinter(printerId: number, job: PrintJob, signal?: AbortSignal): Promise<void> {
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
          signal,
        });
      } finally {
        // Always detach the listener AND clear the cache slot so a failed
        // upload doesn't leave a stale "53%" indicator on the tile. The
        // aborter is owned by `dispatchInBackground` (it spans all retry
        // attempts), so we don't touch it here.
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
