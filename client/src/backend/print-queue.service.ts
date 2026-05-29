import { BaseService } from '@/backend/base.service'
import { ServerApi } from '@/backend/server.api'

export interface QueuedJob {
  id: number
  fileName: string
  queuePosition: number
  status: string
  estimatedTimeSeconds?: number
  filamentGrams?: number | number[]
  createdAt: Date
  // Extra metadata so the next-up hero card can render thumbnails + info
  // without an extra round-trip per row.
  fileStorageId?: string | null
  // For jobs created from the printer's USB storage. Use to fetch the
  // firmware thumbnail when fileStorageId isn't available.
  usbFilePath?: string | null
  usbDisplayName?: string | null
  fileFormat?: 'gcode' | 'bgcode' | '3mf' | null
  fileSize?: number | null
  thumbnails?: Array<{
    index: number
    width: number
    height: number
    format: string
    size: number
  }>
  layerHeight?: number | null
  totalLayers?: number | null
  printerModel?: string | null
  filamentType?: string | null
}

export interface GlobalQueueResponse {
  items: Array<{
    jobId: number
    fileName: string
    printerId: number
    printerName?: string
    queuePosition: number
    status: string
    createdAt: Date
    estimatedTimeSeconds?: number
    filamentGrams?: number
  }>
  page: number
  pageSize: number
  totalCount: number
  totalPages: number
}

export interface PrinterQueueResponse {
  printerId: number
  queue: QueuedJob[]
  count: number
}

export class PrintQueueService extends BaseService {
  static async getGlobalQueue(page: number = 1, pageSize: number = 50): Promise<GlobalQueueResponse> {
    const path = `${ServerApi.printQueueRoute}?page=${page}&pageSize=${pageSize}`
    return this.get<GlobalQueueResponse>(path)
  }

  static async getPrinterQueue(printerId: number): Promise<PrinterQueueResponse> {
    const path = `${ServerApi.printQueueRoute}/${printerId}`
    return this.get<PrinterQueueResponse>(path)
  }

  static async addToQueue(printerId: number, jobId: number, position?: number): Promise<PrinterQueueResponse> {
    const path = `${ServerApi.printQueueRoute}/${printerId}/add/${jobId}`
    return this.post<PrinterQueueResponse>(path, { position })
  }

  static async removeFromQueue(printerId: number, jobId: number): Promise<PrinterQueueResponse> {
    const path = `${ServerApi.printQueueRoute}/${printerId}/${jobId}`
    return this.delete<PrinterQueueResponse>(path)
  }

  static async reorderQueue(printerId: number, jobIds: number[]): Promise<PrinterQueueResponse> {
    const path = `${ServerApi.printQueueRoute}/${printerId}/reorder`
    return this.put<PrinterQueueResponse>(path, { jobIds })
  }

  static async clearQueue(printerId: number): Promise<{ message: string; printerId: number }> {
    const path = `${ServerApi.printQueueRoute}/${printerId}/clear`
    return this.delete<{ message: string; printerId: number }>(path)
  }

  static async getNextInQueue(printerId: number): Promise<{ printerId: number; nextJob: QueuedJob | null }> {
    const path = `${ServerApi.printQueueRoute}/${printerId}/next`
    return this.get<{ printerId: number; nextJob: QueuedJob | null }>(path)
  }

  static async processQueue(printerId: number): Promise<{ message: string; printerId: number; nextJob: QueuedJob | null }> {
    const path = `${ServerApi.printQueueRoute}/${printerId}/process`
    return this.post<{ message: string; printerId: number; nextJob: QueuedJob | null }>(path)
  }

  /**
   * Abort an in-flight queue dispatch for this printer. Used when the
   * tile's "Cancel transfer" button is pressed during STARTING. The
   * server-side promise unwinds, the job rolls back to QUEUED with
   * statusReason="Cancelled by user", and a `printQueue.jobSubmissionFailed`
   * socket event fires with `cancelled: true` so the client can render
   * the friendly toast.
   */
  static async cancelDispatch(printerId: number): Promise<{ message: string; printerId: number }> {
    const path = `${ServerApi.printQueueRoute}/${printerId}/dispatch`
    return this.delete<{ message: string; printerId: number }>(path)
  }

  static async submitToPrinter(jobId: number, printerId: number): Promise<{ message: string; jobId: number; printerId: number }> {
    const path = `${ServerApi.printQueueRoute}/${printerId}/submit/${jobId}`
    return this.post<{ message: string; jobId: number; printerId: number }>(path)
  }

  static async createJobFromFile(printerId: number, fileStorageId: string, position?: number): Promise<PrinterQueueResponse> {
    const path = `${ServerApi.printQueueRoute}/${printerId}/from-file`
    return this.post<PrinterQueueResponse>(path, {
      fileStorageId,
      addToQueue: true,
      position
    })
  }

  /**
   * Queue a file that lives on the printer's USB / firmware storage (not
   * uploaded to File Storage). Mirrors createJobFromFile for the USB source.
   * Returns the freshly-created job (not the full queue) so call sites
   * usually want to follow it up with a separate loadQueue() refresh.
   */
  static async createJobFromUsbFile(
    printerId: number,
    args: {
      filePath: string
      displayName?: string
      fileSize?: number
      addToQueue?: boolean
      position?: number
    }
  ): Promise<UsbFileJobResponse> {
    const path = `${ServerApi.printQueueRoute}/${printerId}/from-usb-file`
    return this.post<UsbFileJobResponse>(path, {
      filePath: args.filePath,
      displayName: args.displayName,
      fileSize: args.fileSize,
      addToQueue: args.addToQueue ?? true,
      position: args.position,
    })
  }

  /** Printers that can actually print a given file (by fileStorageId / jobId / fileFormat). */
  static async getCompatiblePrinters(params: {
    fileStorageId?: string
    jobId?: number
    fileFormat?: 'gcode' | 'bgcode' | '3mf'
  }): Promise<CompatiblePrintersResponse> {
    const qs = new URLSearchParams()
    if (params.fileStorageId) qs.set('fileStorageId', params.fileStorageId)
    if (params.jobId != null) qs.set('jobId', String(params.jobId))
    if (params.fileFormat) qs.set('fileFormat', params.fileFormat)
    return this.get<CompatiblePrintersResponse>(
      `${ServerApi.printQueueRoute}/compatible-printers?${qs.toString()}`
    )
  }

  /**
   * Files in File Storage that the printer can actually print, filtered by
   * printer-type vs file-format (and firmware on PrusaLink). Honors the same
   * folder navigation contract as the storage view.
   */
  static async getAvailableFiles(
    printerId: number,
    folderPath: string | null = null,
    recursive = false
  ): Promise<AvailableFilesResponse> {
    const params = new URLSearchParams()
    if (folderPath) params.set('folderPath', folderPath)
    if (recursive) params.set('recursive', 'true')
    const qs = params.toString()
    const path = `${ServerApi.printQueueRoute}/${printerId}/available-files${qs ? `?${qs}` : ''}`
    return this.get<AvailableFilesResponse>(path)
  }
}

export interface AvailableFileThumbnail {
  index: number
  width: number
  height: number
  format: string
  size: number
}

export interface AvailableFile {
  fileStorageId: string
  fileName: string
  /** User-facing display name (preserved from upload). Falls back to fileName. */
  originalFileName?: string | null
  fileFormat: string
  fileSize: number
  fileHash: string
  createdAt: string | Date
  folderPath: string | null
  estimatedTimeSeconds: number | null
  filamentGrams: number | number[] | null
  totalLayers: number | null
  thumbnails: AvailableFileThumbnail[]
}

export interface CompatiblePrintersResponse {
  fileFormat: string | null
  fileName: string | null
  compatible: Array<Record<string, any>>
  incompatible: Array<Record<string, any> & { incompatibilityReason?: string }>
}

export interface UsbFileJobResponse {
  id: number
  printerId: number | null
  printerName: string | null
  fileName: string
  usbFilePath: string | null
  usbDisplayName: string | null
  fileFormat: 'gcode' | 'bgcode' | '3mf' | null
  status: string
  analysisState: string
  createdAt: string | Date
  addedToQueue: boolean
}

export interface AvailableFolder {
  path: string
  name: string
  createdAt: string | Date
}

export interface AvailableFilesResponse {
  printerId: number
  printerName: string
  printerType: number | string
  printerModel: string | null
  folderPath: string
  folders: AvailableFolder[]
  files: AvailableFile[]
  totalCount: number
  incompatibleCount: number
  primarySource: 'storage'
  secondarySource: 'usb'
}
