import { BaseService } from "@/backend/base.service";
import { ServerApi } from "@/backend/server.api";
import { FilesDto } from "@/models/printers/printer-file.model";
import { PrinterDto } from "@/models/printers/printer.model";
import { useSnackbar } from "@/shared/snackbar.composable";
import { downloadFileByBlob } from "@/utils/download-file.util";

export class PrinterRemoteFileService extends BaseService {
  static async getFiles(
    printerId: number,
    recursive = false,
    startDir?: string,
    filterCompatible = false,
  ) {
    let path = `${ServerApi.printerRemoteFilesRoute}/${printerId}?recursive=${recursive}`;
    if (startDir) {
      path += `&startDir=${encodeURIComponent(startDir)}`;
    }
    if (filterCompatible) {
      path += `&filterCompatible=true`;
    }

    return await this.get<FilesDto>(path);
  }

  static async getThumbnail(printerId: number) {
    const path = `${ServerApi.printerRemoteFilesRoute}/${printerId}/thumbnail`;

    return await this.get<{
      id?: string
      thumbnailBase64: string
      jobId?: number
      fileName?: string
      updatedAt?: string
      // Server enriches with active-job metadata so the preview dialog can
      // render "120 g · PLA · 24h 30m" without an extra round-trip. Older
      // server builds (or printers with no analyzed job) omit this field.
      job?: {
        jobId: number
        fileName: string
        estimatedSeconds: number | null
        metadata: {
          filamentUsedGrams: number | number[] | null
          filamentType: string | null
          printerModel: string | null
          layerHeight: number | null
          nozzleTemperature: number | null
          bedTemperature: number | null
          gcodePrintTimeSeconds: number | null
        } | null
      } | null
    } | null>(path)
  }

  static async selectAndPrintFile(
    printerId: number,
    filePath: string,
    print = true,
  ) {
    const path = ServerApi.printerFilesStartPrintRoute(printerId);
    return await this.post(path, { filePath, print });
  }

  static async uploadFile(printer: PrinterDto, file: File, startPrint: boolean = true) {
    const path = ServerApi.printerFilesUploadRoute(printer.id);

    const formData = new FormData();
    formData.append("startPrint", startPrint.toString());
    formData.append("files[0]", file);

    return this.postUpload(path, formData, {
      onUploadProgress: (progress) => {
        const snackbar = useSnackbar();
        snackbar.openProgressMessage(
          "single-file-upload",
          `Uploading file ${file.name}`,
          (100 * progress.loaded) / progress.total!,
          false,
        );
      },
    });
  }

  static async deleteFileOrFolder(printerId: number, path: string) {
    const urlPath = `${
      ServerApi.printerRemoteFilesRoute
    }/${printerId}?path=${encodeURIComponent(path)}`;
    return this.delete(urlPath);
  }

  static async createFolder(printerId: number, path: string) {
    const urlPath = ServerApi.printerFilesCreateFolderRoute(printerId);
    return this.post(urlPath, { path });
  }

  /**
   * Fetch the firmware-side thumbnail (PrusaLink / similar) for a file
   * that lives on the printer's storage. Returns a base64 data URL the
   * UI can drop into an <img src>.
   *
   * Variant "small" is good for inline cells, "big" for hero previews.
   */
  static async getFirmwareThumbnail(
    printerId: number,
    path: string,
    variant: 'small' | 'big' = 'big',
  ): Promise<string | null> {
    // Server route is `/firmware-thumbnail/:path` so the entire path
    // (slashes included) must be passed as a single encoded segment —
    // matching how downloadFile does it. Encoding segments separately
    // makes Express interpret each `/` as a route separator and 404s.
    const encoded = encodeURIComponent(path)
    const url = `${ServerApi.printerRemoteFilesRoute}/${printerId}/firmware-thumbnail/${encoded}?variant=${variant}`
    try {
      const response = await this.getDownload<ArrayBuffer>(url)
      const mime = (response.headers['content-type'] as string) || 'image/png'
      const buffer = new Uint8Array(response.data)
      // chunked base64 to avoid call-stack overflow on largish PNGs
      let binary = ''
      const chunk = 0x8000
      for (let i = 0; i < buffer.length; i += chunk) {
        binary += String.fromCharCode.apply(null, Array.from(buffer.subarray(i, i + chunk)) as any)
      }
      return `data:${mime};base64,${btoa(binary)}`
    } catch (err) {
      console.debug(`Failed to fetch firmware thumbnail for ${path} on printer ${printerId}:`, err)
      return null
    }
  }

  static async downloadFile(printerId: number, path: string) {
    const urlPath = `${
      ServerApi.printerRemoteFilesRoute
    }/${printerId}/download/${encodeURIComponent(path)}`;
    const arrayBuffer = await this.getDownload(urlPath);
    downloadFileByBlob(arrayBuffer.data, path);
  }
}
