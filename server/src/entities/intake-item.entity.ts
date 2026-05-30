import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from "typeorm";
import { User } from "@/entities/user.entity";

/**
 * Where an intake item came from. Generic on purpose: today only the slicer
 * (OctoPrint-compatible upload) feeds the inbox, but the ERP or any other API
 * caller will reuse the same table with a different `source`.
 */
export type IntakeSource = "prusaslicer" | "erp" | "api";

/**
 * Lifecycle of an item in the intake inbox.
 *   - PENDING:    just arrived via the API, untouched. Counts toward the badge.
 *   - ARCHIVED:   operator chose a folder only (saved to File Storage, no print).
 *   - DISPATCHED: operator assigned it to a printer (queued).
 *   - DISCARDED:  operator threw it away (staging bytes deleted).
 * Only PENDING items still hold staging bytes; the rest are terminal and the
 * staging file has been promoted to File Storage or deleted.
 */
export type IntakeStatus = "PENDING" | "ARCHIVED" | "DISPATCHED" | "DISCARDED";

/**
 * A print file that landed through the API (PrusaSlicer "Print Host" upload,
 * later an ERP) and is waiting for an operator to decide where to file it and
 * which printer to run it on. Its bytes live in a staging dir until resolved;
 * see IntakeService for the staging → File Storage promotion.
 */
@Entity()
@Index(["status"])
export class IntakeItem {
  @PrimaryGeneratedColumn()
  id: number;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: "varchar", nullable: false, default: "prusaslicer" })
  source: IntakeSource;

  /** Arbitrary per-source payload (e.g. ERP order id, customer, requested qty). */
  @Column({ type: "json", nullable: true })
  sourceMetadata: Record<string, unknown> | null;

  @Column({ nullable: false })
  originalFileName: string;

  @Column({ type: "varchar", nullable: true })
  fileFormat: string | null;

  @Column({ type: "int", nullable: false, default: 0 })
  fileSize: number;

  @Column({ type: "varchar", nullable: true })
  fileHash: string | null;

  /** Absolute path of the bytes in the intake staging dir (null once resolved). */
  @Column({ type: "varchar", nullable: true })
  stagingPath: string | null;

  /** Analysis result (print time, filament, printerModel, thumbnails, …). */
  @Column({ type: "json", nullable: true })
  metadata: Record<string, unknown> | null;

  /** Requested number of copies. Defaults to 1; the ERP may send more. */
  @Column({ type: "int", nullable: false, default: 1 })
  quantity: number;

  @Column({ type: "varchar", nullable: false, default: "PENDING" })
  status: IntakeStatus;

  @Column({ type: Date, nullable: true })
  resolvedAt: Date | null;

  @ManyToOne(() => User, { onDelete: "SET NULL", nullable: true })
  resolvedByUser: User | null;
  @Column({ nullable: true })
  resolvedByUserId: number | null;
  @Column({ type: "varchar", nullable: true })
  resolvedBy: string | null;
}
