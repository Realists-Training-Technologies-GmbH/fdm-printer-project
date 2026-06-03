import { computed } from 'vue'
import { useGlobalQueueQuery } from '@/queries/global-queue.query'

export interface PrinterQueueJob {
  jobId: number
  fileName: string
  queuePosition: number
}

/**
 * Per-printer queued jobs, derived from the shared global-queue query (the same
 * one the grid summary bar uses, so this adds no extra request — TanStack
 * dedupes by query key). Each entry in a plate's `printers` array is one queued
 * job assigned to that printer; we group them by printerId and sort by queue
 * position so a tile can show that printer's queue (and its length).
 */
export function usePrinterQueueCounts() {
  const { data } = useGlobalQueueQuery()

  const jobsByPrinterId = computed<Record<number, PrinterQueueJob[]>>(() => {
    const byPrinter: Record<number, PrinterQueueJob[]> = {}
    for (const plate of data.value?.plates ?? []) {
      for (const p of plate.printers) {
        ;(byPrinter[p.printerId] ??= []).push({
          jobId: plate.jobId,
          fileName: plate.fileName,
          queuePosition: p.queuePosition,
        })
      }
    }
    for (const list of Object.values(byPrinter)) {
      list.sort((a, b) => a.queuePosition - b.queuePosition)
    }
    return byPrinter
  })

  const countsByPrinterId = computed<Record<number, number>>(() => {
    const counts: Record<number, number> = {}
    for (const [printerId, list] of Object.entries(jobsByPrinterId.value)) {
      counts[Number(printerId)] = list.length
    }
    return counts
  })

  return { countsByPrinterId, jobsByPrinterId }
}
