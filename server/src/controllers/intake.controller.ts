import { before, DELETE, GET, POST, route } from "awilix-express";
import { AppConstants } from "@/server.constants";
import type { Request, Response } from "express";
import { authenticate, authorizeRoles } from "@/middleware/authenticate";
import { ROLES } from "@/constants/authorization.constants";
import { IntakeService } from "@/services/orm/intake.service";
import type { ILoggerFactory } from "@/handlers/logger-factory";
import { LoggerService } from "@/handlers/logger";
import { ParamId } from "@/middleware/param-converter.middleware";
import { BadRequestException } from "@/exceptions/runtime.exceptions";

/**
 * Intake inbox API. Lists the files that arrived via the API (PrusaSlicer
 * today) and still need an operator decision, and lets them be archived to
 * File Storage, dispatched to a printer, or discarded. Admin/operator only.
 */
@route(AppConstants.apiRoute + "/intake")
@before([authenticate(), authorizeRoles([ROLES.ADMIN, ROLES.OPERATOR])])
export class IntakeController {
  private readonly logger: LoggerService;

  constructor(
    loggerFactory: ILoggerFactory,
    private readonly intakeService: IntakeService,
  ) {
    this.logger = loggerFactory(IntakeController.name);
  }

  @GET()
  @route("/")
  async list(_req: Request, res: Response) {
    const items = await this.intakeService.listPending();
    res.send({
      items: items.map((i) => this.intakeService.toDto(i)),
      count: items.length,
    });
  }

  @POST()
  @route("/:id/archive")
  @before([ParamId("id")])
  async archive(req: Request, res: Response) {
    const id = req.local.id;
    const folderPath = this.normaliseFolderPath(req.body?.folderPath);
    const userId = req.user?.id ?? null;
    const username = req.user?.username || "system";

    const result = await this.intakeService.archive(id, folderPath, userId, username);
    res.send({ ...result, status: "ARCHIVED" });
  }

  @POST()
  @route("/:id/dispatch")
  @before([ParamId("id")])
  async dispatch(req: Request, res: Response) {
    const id = req.local.id;
    const folderPath = this.normaliseFolderPath(req.body?.folderPath);
    const printerId = Number.parseInt(String(req.body?.printerId), 10);
    if (Number.isNaN(printerId)) {
      throw new BadRequestException("printerId is required and must be a number");
    }
    const userId = req.user?.id ?? null;
    const username = req.user?.username || "system";

    const result = await this.intakeService.dispatch(id, { folderPath, printerId }, userId, username);
    res.send({ ...result, status: "DISPATCHED" });
  }

  @DELETE()
  @route("/:id")
  @before([ParamId("id")])
  async discard(req: Request, res: Response) {
    const id = req.local.id;
    const userId = req.user?.id ?? null;
    const username = req.user?.username || "system";

    await this.intakeService.discard(id, userId, username);
    res.send({ id, status: "DISCARDED" });
  }

  /**
   * Inline thumbnail for a pending item. Pending bytes live in staging, not
   * File Storage, so the thumbnail is read from the analysis metadata that was
   * captured at upload time (base64), not from disk.
   */
  @GET()
  @route("/:id/thumbnail/:index")
  @before([ParamId("id")])
  async thumbnail(req: Request, res: Response) {
    const id = req.local.id;
    const index = Number.parseInt(req.params.index, 10);

    const item = await this.intakeService.getByIdOrThrow(id);
    const thumbs = (item.metadata as any)?._thumbnails;
    const thumb = Array.isArray(thumbs) ? thumbs[Number.isNaN(index) ? 0 : index] : null;
    if (!thumb?.data) {
      res.status(404).send({ error: "Thumbnail not available" });
      return;
    }

    const format = (thumb.format || "PNG").toLowerCase();
    const mime = format.includes("jpg") || format.includes("jpeg") ? "image/jpeg" : "image/png";
    res.send({ thumbnailBase64: `data:${mime};base64,${thumb.data}` });
  }

  /** "" / "/" / undefined all mean "root" (null); otherwise the given path. */
  private normaliseFolderPath(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    if (!trimmed || trimmed === "/") return null;
    return trimmed;
  }
}
