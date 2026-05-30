import { randomBytes } from "node:crypto";
import type { ILoggerFactory } from "@/handlers/logger-factory";
import { LoggerService } from "@/handlers/logger";

/** What a ticket grants access to — a single stored file, or a folder ZIP. */
export type DownloadTarget = { kind: "file"; fileStorageId: string } | { kind: "folderZip"; folderPath: string };

interface DownloadTicket {
  target: DownloadTarget;
  userId: number | null;
  expiresAt: number;
}

/**
 * Mints short-lived, single-use tickets that let the browser download a file
 * natively (parallel, with its own progress, surviving navigation) without
 * putting the JWT in the URL. An authenticated endpoint mints a ticket; the
 * public redeem endpoint consumes it once and streams the file.
 *
 * In-memory on purpose: tickets live ~60s and are single-use, so there's no
 * value in persisting them across restarts — a lost ticket just means the
 * client mints another. A periodic sweep drops any that expired unredeemed.
 */
export class DownloadTicketService {
  private readonly logger: LoggerService;
  private readonly tickets = new Map<string, DownloadTicket>();
  private static readonly TTL_MS = 60_000;

  constructor(loggerFactory: ILoggerFactory) {
    this.logger = loggerFactory(DownloadTicketService.name);
  }

  /** Create a one-time ticket for a download target. Returns the ticket string. */
  mint(target: DownloadTarget, userId: number | null): string {
    this.sweep();
    const ticket = randomBytes(24).toString("hex");
    this.tickets.set(ticket, {
      target,
      userId,
      expiresAt: Date.now() + DownloadTicketService.TTL_MS,
    });
    return ticket;
  }

  /**
   * Consume a ticket. Returns its target if valid (and removes it so it can't
   * be reused), or null if unknown/expired.
   */
  redeem(ticket: string): DownloadTarget | null {
    const entry = this.tickets.get(ticket);
    if (!entry) return null;
    this.tickets.delete(ticket);
    if (entry.expiresAt < Date.now()) {
      return null;
    }
    return entry.target;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [ticket, entry] of this.tickets) {
      if (entry.expiresAt < now) {
        this.tickets.delete(ticket);
      }
    }
  }
}
