import { GET, POST, route, before } from "awilix-express";
import type { Request, Response } from "express";
import { FileStorageService } from "@/services/file-storage.service";
import { MulterService } from "@/services/core/multer.service";
import { IntakeService } from "@/services/orm/intake.service";
import type { ILoggerFactory } from "@/handlers/logger-factory";
import { LoggerService } from "@/handlers/logger";
import { AppConstants } from "@/server.constants";
import { slicerApiKeyAuth } from "@/middleware/slicer-api-key.middleware";
import { extname } from "node:path";

/**
 * OctoPrint-compatible API for PrusaSlicer and other slicer integration
 * Implements minimal OctoPrint API surface for file upload
 *
 * File operations require authentication
 */
@route("/api")
@before([slicerApiKeyAuth()])
export class SlicerCompatController {
  private readonly logger: LoggerService;

  constructor(
    loggerFactory: ILoggerFactory,
    private readonly fileStorageService: FileStorageService,
    private readonly multerService: MulterService,
    private readonly intakeService: IntakeService,
  ) {
    this.logger = loggerFactory(SlicerCompatController.name);
  }

  /**
   * OctoPrint version endpoint
   * GET /api/version
   */
  @GET()
  @route("/version")
  async getVersion(req: Request, res: Response) {
    res.send({
      api: "0.1",
      server: "1.9.0",
      text: "OctoPrint 1.9.3",
    });
  }

  /**
   * OctoPrint files endpoint - Upload file
   * POST /api/files/local
   *
   * This endpoint mimics OctoPrint's file upload API for slicer compatibility
   * PrusaSlicer uses: POST /api/files/local with multipart form data
   */
  @POST()
  @route("/files/local")
  async uploadFile(req: Request, res: Response) {
    let files: Express.Multer.File[] | undefined;

    try {
      // Accept all common 3D printer file formats
      const acceptedExtensions = [
        ...AppConstants.defaultAcceptedGcodeExtensions,
        ...AppConstants.defaultAccepted3mfExtensions,
      ];

      // Load uploaded file using multer
      files = await this.multerService.multerLoadFileAsync(req, res, acceptedExtensions, true);

      if (!files?.length) {
        res.status(400).send({
          error: "No file uploaded",
        });
        return;
      }

      const file = files[0];

      // Files from a slicer don't go straight into File Storage anymore — they
      // land in the Intake inbox, where an operator decides the folder and the
      // target printer. We hand the temp bytes to IntakeService, which moves
      // them into the staging dir under the original name (with extension) and
      // analyzes them there — the analyzer dispatches on extension, and multer's
      // temp file has none, so analyzing the temp path directly would fail.
      const fileHash = await this.fileStorageService.calculateFileHash(file.path);
      const fileFormat = extname(file.originalname).slice(1).toLowerCase() || null;

      const item = await this.intakeService.createFromUpload({
        originalFileName: file.originalname,
        fileFormat,
        fileSize: file.size,
        fileHash,
        tempPath: file.path,
        source: "prusaslicer",
      });
      const thumbnailCount = item.metadata
        ? Array.isArray((item.metadata as any)._thumbnails)
          ? (item.metadata as any)._thumbnails.length
          : 0
        : 0;
      const metadata = (item.metadata as any) ?? {};

      // Return OctoPrint-compatible response so the slicer reports success.
      res.status(201).send({
        files: {
          local: {
            name: file.originalname,
            origin: "local",
            refs: {
              resource: `/api/files/local/intake-${item.id}`,
              download: `/api/files/local/intake-${item.id}`,
            },
          },
        },
        done: true,
        _prusaHero: {
          intakeItemId: item.id,
          fileHash,
          analyzed: Object.keys(metadata).length > 0,
          thumbnailCount,
          printTime: metadata.gcodePrintTimeSeconds,
          filament: metadata.filamentUsedGrams,
        },
      });

      this.logger.log(`Slicer upload received into intake: ${file.originalname} -> intake item ${item.id}`);
    } catch (error) {
      // Clean up temp file if it exists (createFromUpload only moves it on
      // success, so a failure leaves the temp file for us to remove).
      if (files?.[0]?.path) {
        try {
          this.multerService.clearUploadedFile(files[0]);
        } catch (e) {
          this.logger.error(`Could not remove uploaded file from temporary storage`);
        }
      }

      // Re-throw to let exception filter handle it properly
      throw error;
    }
  }

  /**
   * Files list endpoint
   * GET /api/files
   */
  @GET()
  @route("/files")
  async listFiles(req: Request, res: Response) {
    try {
      const files = await this.fileStorageService.listAllFiles();

      // Convert to known format
      const knownFiles = files.map((file) => ({
        name: file.metadata?._originalFileName || file.fileName,
        path: file.fileStorageId,
        type: "machinecode",
        typePath: ["machinecode", file.fileFormat],
        origin: "local",
        refs: {
          resource: `/api/files/local/${file.fileStorageId}`,
          download: `/api/files/local/${file.fileStorageId}`,
        },
        gcodeAnalysis: file.metadata
          ? {
              estimatedPrintTime: file.metadata.gcodePrintTimeSeconds,
              filament: {
                tool0: {
                  length: file.metadata.filamentUsedMm,
                  volume: file.metadata.filamentUsedCm3,
                },
              },
            }
          : undefined,
        date: Math.floor(file.createdAt.getTime() / 1000),
        size: file.fileSize,
      }));

      res.send({
        files: knownFiles,
        free: 0, // Not applicable
        total: 0, // Not applicable
      });
    } catch (error) {
      this.logger.error(`Failed to list files via printer API: ${error}`);
      throw error;
    }
  }

  /**
   * Server endpoint (for compatibility checks)
   * GET /api/server
   */
  @GET()
  @route("/server")
  async getServer(req: Request, res: Response) {
    res.send({
      version: "1.9.0",
      safemode: null,
    });
  }
}
