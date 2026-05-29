import { LoggerService } from "@/handlers/logger";
import type { ILoggerFactory } from "@/handlers/logger-factory";
import EventEmitter2 from "eventemitter2";
import { PrintJobService } from "@/services/orm/print-job.service";
import { FileStorageService } from "@/services/file-storage.service";
import { FileAnalysisService } from "@/services/file-analysis.service";
import { PrinterApiFactory } from "@/services/printer-api.factory";
import type { IPrinterApi } from "@/services/printer-api.interface";
import type { PrintJob } from "@/entities/print-job.entity";
import { PrinterCache } from "@/state/printer.cache";
import { captureException } from "@sentry/node";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Service responsible for downloading files from printers for analysis
 * Handles the printJob.needsFileDownload event
 */
export class PrintFileDownloaderService {
  logger: LoggerService;

  constructor(
    loggerFactory: ILoggerFactory,
    private readonly eventEmitter2: EventEmitter2,
    private readonly printJobService: PrintJobService,
    private readonly fileStorageService: FileStorageService,
    private readonly fileAnalysisService: FileAnalysisService,
    private readonly printerApiFactory: PrinterApiFactory,
    private readonly printerCache: PrinterCache,
  ) {
    this.logger = loggerFactory(PrintFileDownloaderService.name);

    // Register event handler
    this.eventEmitter2.on("printJob.needsFileDownload", (event: { jobId: number }) => {
      this.handleFileDownloadRequest(event.jobId).catch((error) => {
        this.logger.error(`Failed to handle file download for job ${event.jobId}`, error);
        captureException(error);
      });
    });

    this.logger.log("Print file downloader service initialized");
  }

  private async handleFileDownloadRequest(jobId: number): Promise<void> {
    this.logger.log(`Handling file download request for job ${jobId}`);

    try {
      const job = await this.printJobService.getJobByIdOrFail(jobId);

      // Check if already has storage ID (race condition protection)
      if (job.fileStorageId) {
        this.logger.log(`Job ${jobId} already has fileStorageId ${job.fileStorageId} - skipping download`);
        return;
      }

      if (!job.printerId) {
        this.logger.error(`Job ${jobId} has no printerId - cannot download file`);
        return;
      }

      const printer = await this.printerCache.getValue(job.printerId);
      if (!printer) {
        this.logger.error(`Printer ${job.printerId} not found for job ${jobId}`);
        return;
      }

      // Get printer API
      const printerApi = this.printerApiFactory.getById(job.printerId);

      // Prefer the storage-relative path the poll captured (e.g.
      // "Production/AT16/file.bgcode") because PrusaLink's download URL builder
      // is rooted at the storage and a bare leaf filename 404s when the file
      // lives inside subfolders. Falls back to fileName for jobs that predate
      // the poll-side path capture.
      const downloadPath = job.usbFilePath ?? job.fileName;
      this.logger.log(`Downloading file ${downloadPath} from printer ${printer.name} (${printer.printerType})`);

      // Download file from printer
      let fileBuffer: Buffer;
      try {
        fileBuffer = await this.downloadFileWithSearchFallback(printerApi, job, downloadPath);
      } catch (downloadError) {
        this.logger.error(`Failed to download file from printer: ${downloadError}`);

        // Mark job as failed analysis
        job.analysisState = "FAILED";
        job.statusReason = `File download failed: ${downloadError instanceof Error ? downloadError.message : "Unknown error"}`;
        await this.printJobService.printJobRepository.save(job);
        return;
      }

      this.logger.log(`Downloaded ${fileBuffer.length} bytes for job ${jobId}`);

      // Create temporary file
      const tempPath = join(tmpdir(), `prusahero-download-${jobId}-${Date.now()}-${job.fileName}`);
      writeFileSync(tempPath, fileBuffer);

      try {
        // Calculate hash
        const fileHash = await this.fileStorageService.calculateFileHash(tempPath);
        this.logger.log(`File hash for job ${jobId}: ${fileHash.substring(0, 12)}...`);

        // Check for duplicate
        const existingJob = await this.fileStorageService.findDuplicateByHash(fileHash);

        let metadata;
        let fileStorageId: string;

        if (existingJob?.fileStorageId) {
          // Found duplicate - reuse existing storage
          const cachedMetadata = await this.fileStorageService.loadMetadata(existingJob.fileStorageId);

          if (cachedMetadata) {
            this.logger.log(
              `Duplicate file detected (job ${existingJob.id}, hash match) - reusing storage ${existingJob.fileStorageId}`,
            );
            metadata = {
              ...cachedMetadata,
              fileName: job.fileName,
            };
            fileStorageId = existingJob.fileStorageId;
          } else if (existingJob.analysisState === "ANALYZED" && existingJob.metadata) {
            this.logger.log(
              `Duplicate file with DB metadata (job ${existingJob.id}) - reusing storage ${existingJob.fileStorageId}`,
            );
            metadata = {
              ...existingJob.metadata,
              fileName: job.fileName,
            };
            fileStorageId = existingJob.fileStorageId;

            // Save metadata JSON for future
            await this.fileStorageService.saveMetadata(fileStorageId, metadata, fileHash, job.fileName);
          } else {
            // Duplicate hash but not analyzed - reuse storage, analyze file
            this.logger.log(
              `Duplicate file not analyzed - reusing storage ${existingJob.fileStorageId}, analyzing now`,
            );
            const existingFilePath = this.fileStorageService.getFilePath(existingJob.fileStorageId);
            const analysisResult = await this.fileAnalysisService.analyzeFile(existingFilePath);
            metadata = analysisResult.metadata;
            fileStorageId = existingJob.fileStorageId;
            await this.fileStorageService.saveMetadata(fileStorageId, metadata, fileHash, job.fileName);
          }
        } else {
          // New file - analyze and store
          this.logger.log(`Analyzing downloaded file: ${job.fileName}`);
          const analysisResult = await this.fileAnalysisService.analyzeFile(tempPath);
          metadata = analysisResult.metadata;
          const thumbnails = analysisResult.thumbnails;

          this.logger.log(
            `Analysis complete: format=${metadata.fileFormat}, layers=${metadata.totalLayers}, time=${metadata.gcodePrintTimeSeconds}s, filament=${metadata.filamentUsedGrams}g`,
          );

          // Save file to storage (with proper file object simulation)
          const fileObject = {
            path: tempPath,
            originalname: job.fileName,
            mimetype: "application/octet-stream",
            size: fileBuffer.length,
          } as Express.Multer.File;

          fileStorageId = await this.fileStorageService.saveFile(fileObject, fileHash);
          this.logger.log(`Saved file to storage: ${fileStorageId}`);

          let thumbnailMetadata: any[] = [];
          if (thumbnails.length > 0) {
            thumbnailMetadata = await this.fileStorageService.saveThumbnails(fileStorageId, thumbnails);
            this.logger.log(`Saved ${thumbnailMetadata.length} thumbnail(s) for ${fileStorageId}`);
          }

          await this.fileStorageService.saveMetadata(
            fileStorageId,
            metadata,
            fileHash,
            job.fileName,
            thumbnailMetadata,
          );
          this.logger.log(`Saved metadata JSON for ${fileStorageId}`);
        }

        job.fileStorageId = fileStorageId;
        job.fileHash = fileHash;
        job.fileSize = fileBuffer.length;
        job.fileFormat = metadata.fileFormat;
        job.metadata = metadata;
        job.analysisState = "ANALYZED";
        job.analyzedAt = new Date();
        await this.printJobService.printJobRepository.save(job);

        this.logger.log(
          `Successfully processed downloaded file for job ${jobId}: storageId=${fileStorageId}, analysisState=${job.analysisState}`,
        );
      } finally {
        try {
          unlinkSync(tempPath);
        } catch (cleanupError) {
          this.logger.warn(`Failed to clean up temp file ${tempPath}: ${cleanupError}`);
        }
      }
    } catch (error) {
      this.logger.error(`Failed to download and analyze file for job ${jobId}`, error);
      captureException(error);

      try {
        const job = await this.printJobService.printJobRepository.findOne({ where: { id: jobId } });
        if (job) {
          job.analysisState = "FAILED";
          job.statusReason = `File download/analysis failed: ${error instanceof Error ? error.message : "Unknown error"}`;
          await this.printJobService.printJobRepository.save(job);
        }
      } catch (updateError) {
        this.logger.error(`Failed to mark job ${jobId} as failed`, updateError);
      }
    }
  }

  /**
   * Download the file from the printer, falling back to a bounded BFS through
   * the printer's storage when the direct path fails. Used to self-heal jobs
   * that only have a leaf `fileName` (e.g. captured from polling before
   * `usbFilePath` was persisted) — without this rescue path those would 404
   * forever because PrusaLink's download URL is rooted at the storage and a
   * bare leaf isn't enough to locate a file nested in subfolders.
   */
  private async downloadFileWithSearchFallback(
    printerApi: IPrinterApi,
    job: PrintJob,
    initialPath: string,
  ): Promise<Buffer> {
    try {
      return await this.streamDownload(printerApi, initialPath);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status !== 404) throw err;

      const leaf = initialPath.split(/[\\/]/).pop()!;
      this.logger.warn(`Direct download of "${initialPath}" returned 404 — searching storage by leaf "${leaf}"`);

      const resolved = await this.findFileByLeafName(printerApi, leaf);
      if (!resolved) throw err;

      this.logger.log(`Resolved "${leaf}" to storage path "${resolved}" — persisting and retrying download`);
      job.usbFilePath = resolved;
      await this.printJobService.printJobRepository.save(job);

      return await this.streamDownload(printerApi, resolved);
    }
  }

  private async streamDownload(printerApi: IPrinterApi, path: string): Promise<Buffer> {
    const response = await printerApi.downloadFile(path);

    const chunks: Buffer[] = [];
    const stream = response.data;
    // Two-tier timeout. PrusaLink's HTTP server is single-threaded and slow,
    // so legitimate downloads of large .bgcode/.gcode files can take a while —
    // but a printer that vanishes mid-stream (Wi-Fi drop, power cycle) leaves
    // the TCP connection hanging without surfacing an error for ~30-120s.
    // Without these, the analyser stays stuck on a dead job, blocking the
    // event loop's retry path. Idle: 30s since the last chunk → assume the
    // peer disappeared. Overall: 5 min hard cap so a slowloris-ish printer
    // can't pin the worker forever.
    const idleTimeoutMs = 30_000;
    // PrusaLink streams are throughput-bound: a printer that's actively
    // printing can only spare a fraction of its single-threaded HTTP server
    // for the download, and full-quality .gcode for long prints (e.g. 25h /
    // 370g jobs) routinely exceed 100 MB. With 3 concurrent retries across
    // the farm the effective per-stream throughput drops to a trickle — 5
    // minutes was too tight and tripped the cap on healthy downloads. 15 min
    // matches the worst-case throughput we've observed in this farm.
    const overallTimeoutMs = 15 * 60_000;

    await new Promise<void>((resolve, reject) => {
      let idleTimer: NodeJS.Timeout;
      const overallTimer = setTimeout(() => {
        clearTimeout(idleTimer);
        stream.destroy(new Error(`Download exceeded ${overallTimeoutMs}ms hard cap`));
      }, overallTimeoutMs);
      const resetIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          stream.destroy(new Error(`Download stalled — no data for ${idleTimeoutMs}ms`));
        }, idleTimeoutMs);
      };
      resetIdle();

      stream.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        resetIdle();
      });
      stream.on("end", () => {
        clearTimeout(idleTimer);
        clearTimeout(overallTimer);
        resolve();
      });
      stream.on("error", (err) => {
        clearTimeout(idleTimer);
        clearTimeout(overallTimer);
        reject(err);
      });
    });
    return Buffer.concat(chunks);
  }

  /**
   * Walk the printer's storage looking for a file whose display name (or
   * addressable name) matches `leafName`. Returns the storage-relative path of
   * the first match, or null when not found.
   *
   * Best-first traversal scored by token overlap with the target leaf: a
   * filename like "AT16-p6.3_Haut-Rahmen-…" prioritises folders named "AT16",
   * "AT16-Produktion-XL", etc. before falling back to siblings. Crucial for
   * deep production trees — a plain BFS exhausts its budget on shallow
   * irrelevant branches before reaching the right subtree. Bounds keep the
   * cost finite on huge USBs.
   */
  private async findFileByLeafName(printerApi: IPrinterApi, leafName: string): Promise<string | null> {
    const targetUpper = leafName.trim().toUpperCase();
    const maxFolders = 128;
    const maxEntries = 8000;

    // 2+ char alphanumeric tokens. Single chars match everything and add
    // nothing but noise; punctuation isn't part of any folder name.
    const targetTokens = leafName
      .toUpperCase()
      .split(/[^A-Z0-9]+/)
      .filter((t) => t.length >= 2);

    const scoreDir = (dirPath: string): number => {
      const upper = dirPath.toUpperCase();
      let score = 0;
      for (const t of targetTokens) {
        if (upper.includes(t)) score++;
      }
      return score;
    };

    // Best-first priority queue: highest-scoring dir popped first. Insertion
    // sort on each enqueue is fine — the queue stays small in practice (a few
    // dozen entries at most before we exhaust the folder budget).
    type Entry = { path: string; score: number };
    const queue: Entry[] = [{ path: "", score: 0 }];
    const visited = new Set<string>();
    let entriesSeen = 0;

    while (queue.length > 0 && visited.size < maxFolders) {
      const { path: dir } = queue.shift()!;
      if (visited.has(dir)) continue;
      visited.add(dir);

      let listing;
      try {
        listing = await printerApi.getFiles(false, dir);
      } catch (e) {
        this.logger.debug(`Listing failed for "${dir}" during search: ${e}`);
        continue;
      }

      for (const file of listing.files) {
        entriesSeen++;
        if (entriesSeen > maxEntries) return null;
        const leafFromPath = file.path.split(/[\\/]/).pop() ?? "";
        const display = (file.displayName ?? "").toUpperCase();
        if (leafFromPath.toUpperCase() === targetUpper || display === targetUpper) {
          return file.path;
        }
      }

      for (const sub of listing.dirs) {
        if (visited.has(sub.path)) continue;
        const entry = { path: sub.path, score: scoreDir(sub.path) };
        // Insert keeping descending order by score, FIFO within equal scores.
        let i = 0;
        while (i < queue.length && queue[i].score >= entry.score) i++;
        queue.splice(i, 0, entry);
      }
    }

    return null;
  }
}
