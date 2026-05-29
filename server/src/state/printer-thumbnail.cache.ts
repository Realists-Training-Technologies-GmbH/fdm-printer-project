import { KeyDiffCache } from "@/utils/cache/key-diff.cache";
import type { ILoggerFactory } from "@/handlers/logger-factory";
import { LoggerService } from "@/handlers/logger";
import { PrintJobService } from "@/services/orm/print-job.service";
import { FileStorageService } from "@/services/file-storage.service";
import { FileAnalysisService } from "@/services/file-analysis.service";
import EventEmitter2 from "eventemitter2";

export interface CachedPrinterThumbnail {
  printerId: number;
  thumbnailBase64: string;
  jobId: number;
  fileName: string;
  updatedAt: Date;
}

/**
 * Cache for printer thumbnails using analyzed print job files
 * Automatically uses the most recent completed or active print job thumbnail
 */
export class PrinterThumbnailCache extends KeyDiffCache<CachedPrinterThumbnail> {
  private readonly logger: LoggerService;

  constructor(
    loggerFactory: ILoggerFactory,
    private readonly printJobService: PrintJobService,
    private readonly fileStorageService: FileStorageService,
    private readonly fileAnalysisService: FileAnalysisService,
    private readonly eventEmitter2: EventEmitter2,
  ) {
    super();
    this.logger = loggerFactory(PrinterThumbnailCache.name);
  }

  async loadCache() {
    this.logger.log("Loading printer thumbnail cache from print jobs...");
    try {
      // Get all printers with recent jobs that have thumbnails
      const recentJobs = await this.printJobService.printJobRepository
        .createQueryBuilder("job")
        .select("job.printerId")
        .addSelect("MAX(job.endedAt)", "maxEndedAt")
        .where("job.fileStorageId IS NOT NULL")
        .andWhere("job.analysisState = :state", { state: "ANALYZED" })
        .groupBy("job.printerId")
        .getRawMany();

      let loadedCount = 0;
      for (const result of recentJobs) {
        const printerId = result.job_printerId;
        if (printerId) {
          try {
            await this.loadPrinterThumbnail(printerId);
            loadedCount++;
          } catch (error) {
            this.logger.warn(`Failed to load thumbnail for printer ${printerId}: ${error}`);
          }
        }
      }

      this.logger.log(`Loaded ${loadedCount} printer thumbnails from print jobs`);
    } catch (error) {
      this.logger.error("Failed to load thumbnail cache", error);
    }
  }

  /**
   * Load thumbnail for a specific printer from its most recent print job
   */
  async loadPrinterThumbnail(printerId: number): Promise<void> {
    try {
      // Find most recent job with thumbnails for this printer
      const job = await this.printJobService.printJobRepository.findOne({
        where: {
          printerId,
          analysisState: "ANALYZED",
        },
        order: {
          endedAt: "DESC",
          startedAt: "DESC",
          createdAt: "DESC",
        },
      });

      if (!job || !job.fileStorageId) {
        this.logger.debug(`No suitable job found for printer ${printerId}`);
        return;
      }

      // Load metadata to check for thumbnails
      const metadata = await this.fileStorageService.loadMetadata(job.fileStorageId);
      const thumbnails = metadata?._thumbnails || [];

      if (thumbnails.length === 0) {
        this.logger.debug(`No thumbnails found for job ${job.id}`);
        return;
      }

      // Pick the highest-quality embedded thumbnail. PrusaSlicer ships both a
      // tiny 16×16 icon and a large preview (e.g. 313×173) in the same gcode;
      // index 0 is not necessarily the bigger one.
      const bestIndex = this.pickBestThumbnailIndex(thumbnails);
      const thumbnailBuffer = await this.fileStorageService.getThumbnail(job.fileStorageId, bestIndex);

      if (!thumbnailBuffer) {
        this.logger.warn(`Thumbnail file not found for job ${job.id}`);
        return;
      }

      const thumbnailBase64 = thumbnailBuffer.toString("base64");

      await this.setPrinterThumbnail(printerId, thumbnailBase64, job.id, job.fileName);

      this.logger.debug(`Loaded thumbnail for printer ${printerId} from job ${job.id} (thumbnail #${bestIndex})`);
    } catch (error) {
      this.logger.error(`Failed to load thumbnail for printer ${printerId}: ${error}`);
      throw error;
    }
  }

  /**
   * Set/update printer thumbnail in cache
   */
  async setPrinterThumbnail(
    printerId: number,
    thumbnailBase64: string,
    jobId: number,
    fileName: string,
  ): Promise<void> {
    await this.setKeyValue(printerId, {
      printerId,
      thumbnailBase64,
      jobId,
      fileName,
      updatedAt: new Date(),
    });
    // Lets the client refetch the per-printer thumbnail without waiting for
    // window focus. Fanned out via socket.io by SocketIoTask.
    this.eventEmitter2.emit("printer.thumbnailChanged", { printerId, jobId });
  }

  /**
   * Remove printer thumbnail from cache
   */
  async unsetPrinterThumbnail(printerId: number): Promise<void> {
    await this.deleteKeyValue(printerId);
  }

  /**
   * Reset entire cache
   */
  async resetCache(): Promise<void> {
    this.logger.log("Resetting printer thumbnail cache");
    this.keyValueStore.clear();
    this.resetDiffs();
  }

  /**
   * Update thumbnail after print job completes
   * Called by event handlers when a job finishes
   */
  async handleJobCompleted(printerId: number, jobId: number): Promise<void> {
    try {
      this.logger.log(`Updating thumbnail for printer ${printerId} after job ${jobId} completed`);
      await this.loadPrinterThumbnail(printerId);
    } catch (error) {
      this.logger.error(`Failed to update thumbnail after job completion: ${error}`);
    }
  }

  /**
   * Update thumbnail after print job starts (for active print preview)
   * Called by event handlers when a job starts
   */
  async handleJobStarted(printerId: number, jobId: number): Promise<void> {
    try {
      const job = await this.printJobService.printJobRepository.findOne({
        where: { id: jobId },
      });

      if (!job || !job.fileStorageId) {
        return;
      }

      // Load metadata to check for thumbnails
      let metadata = await this.fileStorageService.loadMetadata(job.fileStorageId);
      let thumbnails = metadata?._thumbnails || [];

      // Self-heal: files analyzed before the gcode parser supported the
      // `thumbnail_QOI`-style PrusaSlicer directive have an empty
      // `_thumbnails` array baked into their .json. Re-run the parser on the
      // local file — if the new parser finds embedded thumbnails, persist
      // them so future loads hit the cache directly.
      if (thumbnails.length === 0) {
        const reextracted = await this.tryReextractThumbnails(job.fileStorageId, job.fileName, job.fileHash);
        if (reextracted && reextracted.length > 0) {
          metadata = await this.fileStorageService.loadMetadata(job.fileStorageId);
          thumbnails = metadata?._thumbnails || [];
          this.logger.log(
            `Re-extracted ${thumbnails.length} thumbnail(s) for file ${job.fileStorageId} (legacy metadata had none)`,
          );
        }
      }

      if (thumbnails.length === 0) {
        return;
      }

      // Same large-preview preference as loadPrinterThumbnail — see comment there.
      const bestIndex = this.pickBestThumbnailIndex(thumbnails);
      const thumbnailBuffer = await this.fileStorageService.getThumbnail(job.fileStorageId, bestIndex);

      if (!thumbnailBuffer) {
        return;
      }

      const thumbnailBase64 = thumbnailBuffer.toString("base64");
      await this.setPrinterThumbnail(printerId, thumbnailBase64, job.id, job.fileName);

      this.logger.debug(
        `Updated thumbnail for printer ${printerId} from started job ${job.id} (thumbnail #${bestIndex})`,
      );
    } catch (error) {
      this.logger.error(`Failed to update thumbnail after job start: ${error}`);
    }
  }

  /**
   * Pick the index of the highest-quality thumbnail. PrusaSlicer routinely
   * embeds a 16×16 icon at index 0 alongside a 313×173 (or larger) preview at
   * index 1 — `getThumbnail(_, 0)` would have shown the tiny one. Largest
   * pixel area wins; byte size breaks ties (better-compressed image at the
   * same resolution is irrelevant for quality, but for two equally-sized
   * captures the larger payload tends to be the less-compressed/higher-quality
   * one). Falls back to index 0 when the metadata is missing dimensions, so a
   * malformed entry never breaks the cache.
   */
  private pickBestThumbnailIndex(thumbnails: Array<{ width?: number; height?: number; size?: number }>): number {
    if (thumbnails.length <= 1) return 0;
    let bestIndex = 0;
    let bestArea = -1;
    let bestSize = -1;
    for (let i = 0; i < thumbnails.length; i++) {
      const t = thumbnails[i];
      const area = (t.width ?? 0) * (t.height ?? 0);
      const size = t.size ?? 0;
      if (area > bestArea || (area === bestArea && size > bestSize)) {
        bestArea = area;
        bestSize = size;
        bestIndex = i;
      }
    }
    return bestIndex;
  }

  /**
   * Re-run the file analyzer on a stored file to refresh its embedded
   * thumbnails into the `.json` sidecar. Used to self-heal files whose
   * metadata was written by an older parser that missed the slicer's newer
   * `thumbnail_QOI`/`thumbnail_PNG`-prefixed directives.
   *
   * Returns the saved thumbnail metadata array on success, or null on any
   * failure (caller is expected to keep going with whatever was already on
   * disk).
   */
  private async tryReextractThumbnails(
    fileStorageId: string,
    fileName: string,
    fileHash: string | null,
  ): Promise<any[] | null> {
    try {
      const filePath = this.fileStorageService.getFilePath(fileStorageId);
      if (!filePath) return null;

      const { metadata, thumbnails } = await this.fileAnalysisService.analyzeFile(filePath);
      if (!thumbnails || thumbnails.length === 0) {
        return null;
      }

      const thumbnailMetadata = await this.fileStorageService.saveThumbnails(fileStorageId, thumbnails);
      await this.fileStorageService.saveMetadata(
        fileStorageId,
        metadata,
        fileHash ?? undefined,
        fileName,
        thumbnailMetadata,
      );
      return thumbnailMetadata;
    } catch (error) {
      this.logger.debug(`Thumbnail re-extraction failed for ${fileStorageId}: ${error}`);
      return null;
    }
  }
}
