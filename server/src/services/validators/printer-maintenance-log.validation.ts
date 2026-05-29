import { z } from "zod";

export const createMaintenanceLogSchema = z.object({
  printerId: z.number().int().positive(),
  metadata: z.object({
    partsInvolved: z.array(z.string()).optional(),
    cause: z.string().optional(),
    notes: z.string().optional(),
  }),
});

export const completeMaintenanceLogSchema = z.object({
  completionNotes: z.string().optional(),
});

export const getMaintenanceLogsQuerySchema = z.object({
  printerId: z.coerce.number().int().positive().optional(),
  completed: z.coerce.boolean().optional(),
  page: z.coerce.number().int().positive().default(1),
  // 500 covers a workshop-sized history without forcing the UI to page;
  // the Maintenance view loads the lot in one shot so we don't lose the
  // active rows at the top of the list to a smaller default.
  pageSize: z.coerce.number().int().positive().max(500).default(20),
});
