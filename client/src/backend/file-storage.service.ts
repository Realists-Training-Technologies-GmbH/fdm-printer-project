import { BaseService } from '@/backend/base.service'
import { triggerBrowserDownload } from '@/utils/download-file.util'
import { ServerApi } from '@/backend/server.api'
import { getBaseUri } from '@/shared/http-client'

export interface ThumbnailInfo {
  index: number
  width: number
  height: number
  format: string
  size: number
}

export interface FileMetadata {
  fileStorageId: string
  fileName: string
  fileFormat: string
  fileSize: number
  fileHash: string
  createdAt: Date
  /** Absolute folder path (e.g. "/clientes/empresa-x"), or null when at root. */
  folderPath: string | null
  thumbnails: ThumbnailInfo[]
  metadata?: {
    gcodePrintTimeSeconds?: number
    filamentUsedGrams?: number
    nozzleDiameterMm?: number
    layerHeight?: number
    totalLayers?: number
    [key: string]: any
  }
}

export interface FolderInfo {
  path: string
  name: string
  createdAt: string | Date
}

export interface FilesListResponse {
  folderPath: string
  folders: FolderInfo[]
  files: FileMetadata[]
  totalCount: number
}

export interface FolderTreeResponse {
  folders: Array<{
    path: string
    parentPath: string | null
    name: string
    createdAt: string | Date
  }>
}

export class FileStorageService extends BaseService {
  static async listFiles(folderPath: string | null = null, recursive = false): Promise<FilesListResponse> {
    const params = new URLSearchParams()
    if (folderPath) params.set('folderPath', folderPath)
    if (recursive) params.set('recursive', 'true')
    const qs = params.toString()
    return this.get<FilesListResponse>(`/api/v2/file-storage${qs ? `?${qs}` : ''}`)
  }

  static async getFolderTree(): Promise<FolderTreeResponse> {
    return this.get<FolderTreeResponse>('/api/v2/file-storage/folders/tree')
  }

  static async createFolder(path: string): Promise<FolderInfo> {
    return this.post<FolderInfo>('/api/v2/file-storage/folders', { path })
  }

  static async renameFolder(from: string, to: string): Promise<{
    folder: FolderInfo
    filesUpdated: number
  }> {
    return this.patch('/api/v2/file-storage/folders', { from, to })
  }

  static async deleteFolder(
    path: string,
    options: { cascade?: boolean; force?: boolean; deleteFiles?: boolean } = {}
  ): Promise<{ deletedPaths: string[]; filesMovedToRoot: number; filesDeleted: number }> {
    const params = new URLSearchParams({ path })
    if (options.cascade) params.set('cascade', 'true')
    if (options.force) params.set('force', 'true')
    // deleteFiles → "rm -rf": also remove the file binaries inside the subtree.
    if (options.deleteFiles) params.set('deleteFiles', 'true')
    return this.delete(`/api/v2/file-storage/folders?${params.toString()}`)
  }

  static async moveFileToFolder(
    fileStorageId: string,
    folderPath: string | null
  ): Promise<FileMetadata> {
    return this.patch(`/api/v2/file-storage/${fileStorageId}/folder`, { folderPath })
  }

  static async getFileMetadata(fileStorageId: string): Promise<FileMetadata> {
    const path = `/api/v2/file-storage/${fileStorageId}`
    return this.get<FileMetadata>(path)
  }

  static async deleteFile(fileStorageId: string): Promise<void> {
    const path = `/api/v2/file-storage/${fileStorageId}`
    return this.delete(path)
  }

  static async analyzeFile(fileStorageId: string): Promise<{
    message: string
    fileStorageId: string
    metadata: any
    thumbnailCount: number
  }> {
    const path = `/api/v2/file-storage/${fileStorageId}/analyze`
    return this.post(path, {})
  }

  static async uploadFile(file: File, folderPath: string | null = null, overwrite = false): Promise<any> {
    const formData = new FormData()
    formData.append('file', file)
    if (folderPath) formData.append('folderPath', folderPath)
    // When set, the backend atomically replaces an existing same-name file in
    // the folder (the old one is only removed after the new one is saved).
    if (overwrite) formData.append('overwrite', 'true')

    const path = '/api/v2/file-storage/upload'
    const response = await this.postUpload(path, formData, {
      headers: {
        'Content-Type': 'multipart/form-data'
      }
    })
    return response.data
  }

  /** Rename a file (keeps its original extension server-side). */
  static async renameFile(fileStorageId: string, name: string): Promise<{ fileStorageId: string; fileName: string }> {
    return this.patch(`/api/v2/file-storage/${fileStorageId}/rename`, { name })
  }

  /**
   * Download a folder (and its subtree) as a .zip via a one-time ticket, so
   * the browser builds/streams it natively (parallel, survives navigation)
   * instead of blocking while we buffer the whole archive in memory.
   */
  static async exportFolderZip(path: string): Promise<void> {
    const { ticket } = await this.post<{ ticket: string }>(
      `${ServerApi.folderExportTicketRoute}?path=${encodeURIComponent(path)}`
    )
    const base = (await getBaseUri()).replace(/\/$/, '')
    triggerBrowserDownload(`${base}${ServerApi.downloadRedeemRoute}?ticket=${encodeURIComponent(ticket)}`)
  }

  /**
   * Download via a one-time ticket so the browser fetches the file natively:
   * the request runs in parallel, shows the browser's own progress, and isn't
   * cancelled when the user navigates away from the page. We mint the ticket
   * with the authenticated client, then hand a plain URL to the browser — no
   * JWT in the URL (the ticket is single-use and short-lived).
   */
  static async downloadFile(fileStorageId: string, _fileName: string): Promise<void> {
    const { ticket } = await this.post<{ ticket: string }>(
      ServerApi.fileDownloadTicketRoute(fileStorageId)
    )
    const base = (await getBaseUri()).replace(/\/$/, '')
    triggerBrowserDownload(`${base}${ServerApi.downloadRedeemRoute}?ticket=${encodeURIComponent(ticket)}`)
  }

  static async getThumbnailBase64(fileStorageId: string, index: number = 0): Promise<string> {
    const path = `/api/v2/file-storage/${fileStorageId}/thumbnail/${index}`
    const response = await this.get<{ thumbnailBase64: string }>(path)
    return response.thumbnailBase64
  }
}
