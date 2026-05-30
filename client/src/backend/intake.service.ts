import { BaseService } from '@/backend/base.service'
import { ServerApi } from '@/backend/server.api'

export type IntakeSource = 'prusaslicer' | 'erp' | 'api'
export type IntakeStatus = 'PENDING' | 'ARCHIVED' | 'DISPATCHED' | 'DISCARDED'

export interface IntakeItem {
  id: number
  createdAt: string | Date
  source: IntakeSource
  sourceMetadata: Record<string, unknown> | null
  originalFileName: string
  fileFormat: string | null
  fileSize: number
  fileHash: string | null
  metadata: {
    printerModel?: string | null
    gcodePrintTimeSeconds?: number | null
    filamentUsedGrams?: number | number[] | null
    layerHeight?: number | null
    filamentType?: string | string[] | null
    totalLayers?: number | null
    [key: string]: any
  } | null
  quantity: number
  status: IntakeStatus
  thumbnailCount: number
  thumbnails: Array<{ index: number; width: number; height: number; format: string; size: number }>
}

export interface IntakeListResponse {
  items: IntakeItem[]
  count: number
}

export class IntakeService extends BaseService {
  static async list(): Promise<IntakeListResponse> {
    return this.get<IntakeListResponse>(ServerApi.intakeRoute)
  }

  static async archive(id: number, folderPath: string | null): Promise<{ fileStorageId: string; status: string }> {
    return this.post(ServerApi.intakeArchiveRoute(id), { folderPath })
  }

  static async dispatch(
    id: number,
    printerId: number,
    folderPath: string | null
  ): Promise<{ fileStorageId: string; printerId: number; jobId: number; status: string }> {
    return this.post(ServerApi.intakeDispatchRoute(id), { printerId, folderPath })
  }

  static async discard(id: number): Promise<{ id: number; status: string }> {
    return this.delete(ServerApi.intakeItemRoute(id))
  }

  static async getThumbnailBase64(id: number, index = 0): Promise<string> {
    const res = await this.get<{ thumbnailBase64: string }>(ServerApi.intakeThumbnailRoute(id, index))
    return res.thumbnailBase64
  }
}
