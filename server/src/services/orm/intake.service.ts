import { Repository } from "typeorm";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, rename, unlink } from "node:fs/promises";
import EventEmitter2 from "eventemitter2";
import { IntakeItem, IntakeSource, IntakeStatus } from "@/entities/intake-item.entity";
import { TypeormService } from "@/services/typeorm/typeorm.service";
import type { ILoggerFactory } from "@/handlers/logger-factory";
import { LoggerService } from "@/handlers/logger";
import { FileStorageService } from "@/services/file-storage.service";
import { FileAnalysisService } from "@/services/file-analysis.service";
import { PrintQueueService } from "@/services/print-queue.service";
import { PrintJobService } from "@/services/orm/print-job.service";
import { PrinterMaintenanceLogService } from "@/services/orm/printer-maintenance-log.service";
import { PrinterCache } from "@/state/printer.cache";
import { getIncompatibilityReason } from "@/utils/printer-compatibility.util";
import { PrusaLinkType, type PrinterType } from "@/services/printer-api.interface";
import { PrinterFirmwareCache } from "@/state/printer-firmware.cache";
import { arePrusaModelsCompatible } from "@/services/prusa-link/utils/prusa-link-model.util";
import type { FileFormatType } from "@/entities/print-job.entity";
import { BadRequestException, NotFoundException } from "@/exceptions/runtime.exceptions";
import { getMediaPath } from "@/utils/fs.utils";
import { intakeEvents } from "@/constants/event.constants";

export interface CreateIntakeItemInput {
  originalFileName: string;
  fileFormat: string | null;
  fileSize: number;
  fileHash: string | null;
  /** Path of the uploaded temp file to move into staging (then analyze). */
  tempPath: string;
  source?: IntakeSource;
  sourceMetadata?: Record<string, unknown> | null;
  quantity?: number;
}

export interface IntakeItemDto {
  id: number;
  createdAt: Date;
  source: IntakeSource;
  sourceMetadata: Record<string, unknown> | null;
  originalFileName: string;
  fileFormat: string | null;
  fileSize: number;
  fileHash: string | null;
  metadata: Record<string, unknown> | null;
  quantity: number;
  status: IntakeStatus;
  thumbnailCount: number;
  /** Descriptors (no base64) so the UI can pick the best one and fetch by index. */
  thumbnails: Array<{ index: number; width: number; height: number; format: string; size: number }>;
}

/**
 * Manages the intake inbox: files that arrived via the API (PrusaSlicer today)
 * and await an operator's decision. PENDING items keep their bytes in a staging
 * dir, separate from File Storage, so the file tree isn't polluted by
 * unclassified uploads. Resolving an item either promotes those bytes into File
 * Storage (archive / dispatch) or deletes them (discard).
 */
export class IntakeService {
  private readonly logger: LoggerService;
  private readonly repository: Repository<IntakeItem>;
  private readonly stagingPath: string;

  constructor(
    loggerFactory: ILoggerFactory,
    typeormService: TypeormService,
    private readonly fileStorageService: FileStorageService,
    private readonly fileAnalysisService: FileAnalysisService,
    private readonly printQueueService: PrintQueueService,
    private readonly printJobService: PrintJobService,
    private readonly printerCache: PrinterCache,
    private readonly printerMaintenanceLogService: PrinterMaintenanceLogService,
    private readonly printerFirmwareCache: PrinterFirmwareCache,
    private readonly eventEmitter2: EventEmitter2,
  ) {
    this.logger = loggerFactory(IntakeService.name);
    this.repository = typeormService.getDataSource().getRepository(IntakeItem);
    this.stagingPath = join(getMediaPath(), "intake");
  }

  async ensureStagingDir(): Promise<void> {
    if (!existsSync(this.stagingPath)) {
      await mkdir(this.stagingPath, { recursive: true });
    }
  }

  toDto(entity: IntakeItem): IntakeItemDto {
    const rawThumbs = (entity.metadata as any)?._thumbnails;
    const thumbs: Array<{ index: number; width: number; height: number; format: string; size: number }> = Array.isArray(
      rawThumbs,
    )
      ? rawThumbs.map((t: any, index: number) => ({
          index,
          width: t.width ?? 0,
          height: t.height ?? 0,
          format: t.format ?? "PNG",
          // base64 → byte length estimate; the cell/viewer fetches bytes by index.
          size: typeof t.data === "string" ? Math.floor((t.data.length * 3) / 4) : 0,
        }))
      : [];
    return {
      id: entity.id,
      createdAt: entity.createdAt,
      source: entity.source,
      sourceMetadata: entity.sourceMetadata,
      originalFileName: entity.originalFileName,
      fileFormat: entity.fileFormat,
      fileSize: entity.fileSize,
      fileHash: entity.fileHash,
      metadata: entity.metadata,
      quantity: entity.quantity,
      status: entity.status,
      thumbnailCount: thumbs.length,
      thumbnails: thumbs,
    };
  }

  /**
   * Create a PENDING intake item from an upload. The caller hands us the temp
   * file path; we move it into the staging dir under the new item's id (keeping
   * the original extension) and analyze it THERE. Analyzing the multer temp
   * path directly fails because that file has no extension and the analyzer
   * dispatches on extension — so the staged copy (with its real extension) is
   * what gets parsed for metadata + thumbnails.
   */
  async createFromUpload(input: CreateIntakeItemInput): Promise<IntakeItem> {
    await this.ensureStagingDir();

    const item = this.repository.create({
      source: input.source ?? "prusaslicer",
      sourceMetadata: input.sourceMetadata ?? null,
      originalFileName: input.originalFileName,
      fileFormat: input.fileFormat,
      fileSize: input.fileSize,
      fileHash: input.fileHash,
      metadata: null,
      quantity: input.quantity ?? 1,
      status: "PENDING",
      stagingPath: null,
    });
    await this.repository.save(item);

    // Name the staging file by id so two same-named uploads don't collide,
    // preserving the original extension so the analyzer can recognise it.
    const ext = input.originalFileName.includes(".")
      ? input.originalFileName.slice(input.originalFileName.lastIndexOf("."))
      : "";
    const stagingFile = join(this.stagingPath, `${item.id}${ext}`);
    await rename(input.tempPath, stagingFile);
    item.stagingPath = stagingFile;

    // Analyze the staged file (has the right extension now). Thumbnails are
    // stashed inline on metadata (_thumbnails, base64) so the row preview can
    // render before promotion and they survive into File Storage on dispatch.
    let metadata: Record<string, unknown> = {};
    try {
      const analysis = await this.fileAnalysisService.analyzeFile(stagingFile);
      metadata = (analysis.metadata as Record<string, unknown>) ?? {};
      const thumbnails = analysis.thumbnails ?? [];
      if (thumbnails.length > 0) {
        (metadata as any)._thumbnails = thumbnails;
      }
    } catch (e) {
      this.logger.error(`Failed to analyze intake file ${input.originalFileName}: ${e}`);
    }
    item.metadata = metadata;
    await this.repository.save(item);

    this.logger.log(`Intake item ${item.id} created from ${input.originalFileName}`);
    this.eventEmitter2.emit(intakeEvents.changed, { kind: "created", id: item.id });
    return item;
  }

  async listPending(): Promise<IntakeItem[]> {
    return this.repository.find({
      where: { status: "PENDING" },
      order: { createdAt: "DESC" },
    });
  }

  async countPending(): Promise<number> {
    return this.repository.count({ where: { status: "PENDING" } });
  }

  async getPendingOrThrow(id: number): Promise<IntakeItem> {
    const item = await this.repository.findOne({ where: { id } });
    if (!item) {
      throw new NotFoundException(`Intake item ${id} not found`);
    }
    if (item.status !== "PENDING") {
      // Optimistic concurrency: another operator already resolved it.
      throw new BadRequestException(
        `Intake item ${id} was already ${item.status.toLowerCase()} and can no longer be acted on.`,
      );
    }
    return item;
  }

  /**
   * Promote a PENDING item's staging bytes into File Storage under the given
   * folder, running them through the same save+metadata+thumbnails pipeline as
   * a normal upload. Returns the new fileStorageId. Does NOT change item status.
   */
  private async promoteToFileStorage(item: IntakeItem, folderPath: string | null): Promise<string> {
    if (!item.stagingPath || !existsSync(item.stagingPath)) {
      throw new BadRequestException(`Intake item ${item.id} has no staged file to promote.`);
    }

    const fileHash = item.fileHash ?? (await this.fileStorageService.calculateFileHash(item.stagingPath));

    // saveFile() consumes `originalname` + `path` and renames the file into the
    // storage tree, which empties the staging file for us.
    const pseudoFile = {
      originalname: item.originalFileName,
      path: item.stagingPath,
    } as Express.Multer.File;

    const fileStorageId = await this.fileStorageService.saveFile(pseudoFile, fileHash, folderPath);

    const metadata = (item.metadata as any) ?? {};
    const thumbnails = Array.isArray(metadata._thumbnails) ? metadata._thumbnails : [];
    let thumbnailMetadata: any[] = [];
    try {
      if (thumbnails.length > 0) {
        thumbnailMetadata = await this.fileStorageService.saveThumbnails(fileStorageId, thumbnails);
      }
    } catch (e) {
      this.logger.warn(`Failed to persist thumbnails for intake item ${item.id}: ${e}`);
    }

    await this.fileStorageService.saveMetadata(
      fileStorageId,
      metadata,
      fileHash,
      item.originalFileName,
      thumbnailMetadata,
      folderPath,
    );

    return fileStorageId;
  }

  private async markResolved(
    item: IntakeItem,
    status: IntakeStatus,
    userId: number | null,
    username: string,
  ): Promise<void> {
    item.status = status;
    item.resolvedAt = new Date();
    item.resolvedByUserId = userId;
    item.resolvedBy = username;
    item.stagingPath = null;
    await this.repository.save(item);
    this.eventEmitter2.emit(intakeEvents.changed, { kind: "resolved", id: item.id, status });
  }

  /** Save to File Storage under a folder without queueing anything. */
  async archive(
    id: number,
    folderPath: string | null,
    userId: number | null,
    username: string,
  ): Promise<{ fileStorageId: string }> {
    const item = await this.getPendingOrThrow(id);
    const fileStorageId = await this.promoteToFileStorage(item, folderPath);
    await this.markResolved(item, "ARCHIVED", userId, username);
    this.logger.log(`Intake item ${id} archived to File Storage (${fileStorageId})`);
    return { fileStorageId };
  }

  /**
   * Save to File Storage (optional folder) and queue it on a printer. Phase 1:
   * a single printer. The compatibility/maintenance guards live in
   * PrintQueueService.createJobFromFile's controller path; here we promote then
   * delegate queueing to the same job-creation flow.
   */
  async dispatch(
    id: number,
    args: { folderPath: string | null; printerId: number },
    userId: number | null,
    username: string,
  ): Promise<{ fileStorageId: string; printerId: number; jobId: number }> {
    const item = await this.getPendingOrThrow(id);
    const printerId = args.printerId;

    // Validate the target printer up front, before we promote the file — a
    // rejection here leaves the item PENDING so the operator can retry.
    const printer = await this.printerCache.getCachedPrinterOrThrowAsync(printerId);

    const inMaintenance = await this.printerMaintenanceLogService.hasActiveByPrinterId(printerId);
    if (inMaintenance) {
      throw new BadRequestException(
        `Printer ${printer.name} has pending maintenance and cannot accept print jobs. Complete the maintenance first.`,
      );
    }

    const fileFormat = (item.fileFormat as FileFormatType | null) ?? undefined;
    const typeReason = getIncompatibilityReason(printer.printerType as PrinterType, fileFormat);
    if (typeReason) {
      throw new BadRequestException(typeReason);
    }

    if (printer.printerType === PrusaLinkType) {
      const info = await this.printerFirmwareCache.getOrFetch(printerId);
      if (fileFormat === "bgcode" && info.supportsBgcode === false) {
        const modelLabel = info.model ?? "this PrusaLink model";
        throw new BadRequestException(
          `Binary G-code (.bgcode) cannot be printed on ${modelLabel}. Re-slice as plain .gcode or pick a Buddy-firmware printer (MK4, MK3.9, MK3.5, XL, MINI+, Core One).`,
        );
      }
      const slicerTarget = ((item.metadata as any)?.printerModel as string | null) ?? null;
      if (slicerTarget && !arePrusaModelsCompatible(slicerTarget, info.model)) {
        const printerLabel = info.model ?? "this printer";
        throw new BadRequestException(
          `This file was sliced for ${slicerTarget}, but ${printerLabel} is a different model family. Pick a printer in the same family.`,
        );
      }
    }

    const fileStorageId = await this.promoteToFileStorage(item, args.folderPath);

    // Use the metadata that File Storage just persisted, not item.metadata:
    // promotion rewrites `_thumbnails` from inline base64 (analysis output) to
    // the on-disk shape (index + path) that the queue's "Next Up" thumbnail
    // endpoint reads back. The intake copy still has the base64 form, which
    // the thumbnail-by-index endpoint can't serve — so the card showed blank.
    const metadata = (await this.fileStorageService.loadMetadata(fileStorageId)) ?? (item.metadata as any) ?? {};
    const job = await this.printJobService.createPendingJob(printerId, item.originalFileName, metadata, printer.name);
    job.fileStorageId = fileStorageId;
    job.fileHash = item.fileHash ?? metadata._fileHash ?? null;
    job.analysisState = "ANALYZED";
    job.analyzedAt = new Date();
    if (item.fileFormat) {
      job.fileFormat = item.fileFormat;
    }
    await this.printJobService.updateJob(job);
    await this.printQueueService.addToQueue(printerId, job.id);

    await this.markResolved(item, "DISPATCHED", userId, username);
    this.logger.log(`Intake item ${id} dispatched to printer ${printerId} (job ${job.id})`);
    return { fileStorageId, printerId, jobId: job.id };
  }

  /** Throw away the staged bytes and mark the item discarded. */
  async discard(id: number, userId: number | null, username: string): Promise<void> {
    const item = await this.getPendingOrThrow(id);
    if (item.stagingPath && existsSync(item.stagingPath)) {
      try {
        await unlink(item.stagingPath);
      } catch (e) {
        this.logger.warn(`Failed to delete staging file for intake item ${id}: ${e}`);
      }
    }
    await this.markResolved(item, "DISCARDED", userId, username);
    this.logger.log(`Intake item ${id} discarded`);
  }

  /** Raw bytes of a pending item's staged file, for the thumbnail/preview. */
  getStagingPath(item: IntakeItem): string | null {
    return item.stagingPath;
  }

  async getByIdOrThrow(id: number): Promise<IntakeItem> {
    const item = await this.repository.findOne({ where: { id } });
    if (!item) {
      throw new NotFoundException(`Intake item ${id} not found`);
    }
    return item;
  }
}
