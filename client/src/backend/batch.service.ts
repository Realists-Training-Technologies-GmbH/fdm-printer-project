import { BaseService } from './base.service'

export class BatchService extends BaseService {
  static async batchConnectUsb(printerIds: number[]) {
    return await this.post('/api/v2/batch/connect/usb', { printerIds })
  }

  static async batchConnectSocket(printerIds: number[]) {
    return await this.post('/api/v2/batch/connect/socket', { printerIds })
  }

  static async batchToggleEnabled(printerIds: number[], enabled: boolean) {
    return await this.post('/api/v2/batch/toggle-enabled', {
      printerIds,
      enabled
    })
  }
}
