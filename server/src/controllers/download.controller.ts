import { GET, route } from "awilix-express";
import { AppConstants } from "@/server.constants";
import type { Request, Response } from "express";
import { FileStorageService } from "@/services/file-storage.service";
import { FileStorageFolderService } from "@/services/file-storage-folder.service";
import { DownloadTicketService } from "@/services/download-ticket.service";
import type { ILoggerFactory } from "@/handlers/logger-factory";
import { LoggerService } from "@/handlers/logger";
import AdmZip from "adm-zip";

/**
 * Public, ticket-gated downloads. Unlike FileStorageController this has NO
 * authenticate() guard — that's the point: a `<a download>` link can't carry a
 * Bearer header, so access is granted by a short-lived, single-use ticket
 * minted elsewhere by an authenticated user. The ticket is the only
 * credential, consumed on redeem. Handles both single files and folder ZIPs.
 */
@route(AppConstants.apiRoute + "/download")
export class DownloadController {
  private readonly logger: LoggerService;

  constructor(
    loggerFactory: ILoggerFactory,
    private readonly fileStorageService: FileStorageService,
    private readonly downloadTicketService: DownloadTicketService,
  ) {
    this.logger = loggerFactory(DownloadController.name);
  }

  /**
   * Redeem a one-time ticket and stream the file (or folder ZIP). GET so it
   * works as a plain browser navigation / `<a download>` (native, parallel,
   * survives leaving the SPA page).
   * GET /api/download/redeem?ticket=…
   */
  @GET()
  @route("/redeem")
  async redeem(req: Request, res: Response) {
    const ticket = typeof req.query.ticket === "string" ? req.query.ticket : "";
    if (!ticket) {
      res.status(400).send({ error: "Missing ticket" });
      return;
    }

    const target = this.downloadTicketService.redeem(ticket);
    if (!target) {
      res.status(403).send({ error: "Invalid or expired download ticket" });
      return;
    }

    if (target.kind === "file") {
      await this.fileStorageService.streamDownload(res, target.fileStorageId);
      return;
    }

    await this.streamFolderZip(res, target.folderPath);
  }

  /**
   * Build and send a ZIP of a folder subtree, rebuilding the folder hierarchy
   * inside the archive from each file's original name + relative path. Mirrors
   * the previous authenticated export so behaviour is unchanged — only the
   * access path (ticket) differs.
   */
  private async streamFolderZip(res: Response, folderPath: string) {
    const all = await this.fileStorageService.listAllFiles();
    const inside = all.filter((f) => {
      const fp: string | null = f.metadata?._folderPath ?? null;
      if (!fp) return false;
      return fp === folderPath || fp.startsWith(folderPath + "/");
    });

    const zip = new AdmZip();
    for (const f of inside) {
      const buffer = await this.fileStorageService.getFile(f.fileStorageId);
      const fp = f.metadata?._folderPath ?? folderPath;
      const relDir = fp === folderPath ? "" : fp.substring(folderPath.length + 1);
      const name = f.metadata?._originalFileName || f.fileName;
      const entryPath = relDir ? `${relDir}/${name}` : name;
      zip.addFile(entryPath, buffer);
    }

    const folderName = FileStorageFolderService.nameOf(folderPath) || "folder";
    const archive = zip.toBuffer();
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${folderName}.zip"`);
    res.setHeader("Content-Length", archive.length.toString());
    res.send(archive);
  }
}
