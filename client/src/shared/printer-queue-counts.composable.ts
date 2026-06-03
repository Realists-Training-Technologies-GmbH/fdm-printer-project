import { computed } from 'vue'
import { useGlobalQueueQuery } from '@/queries/global-queue.query'

/**
 * Per-printer queued-job counts, derived from the shared global-queue query
 * (the same one the grid summary bar uses, so this adds no extra request —
 * TanStack dedupes by query key). Each entry in a plate's `printers` array is
 * one queued job assigned to that printer, so counting them by printerId gives
 * each printer's queue length.
 */
export function usePrinterQueueCounts() {
  const { data } = useGlobalQueueQuery()

  const countsByPrinterId = computed<Record<number, number>>(() => {
    const counts: Record<number, number> = {}
    for (const plate of data.value?.plates ?? []) {
      for (const p of plate.printers) {
        counts[p.printerId] = (counts[p.printerId] ?? 0) + 1
      }
    }
    return counts
  })

  return { countsByPrinterId }
}
