import { onMounted, onUnmounted } from 'vue'
import type { EventBusKey } from '@vueuse/core'
import { useEventBus } from '@vueuse/core'

/**
 * Tiny event bus that broadcasts "the printer-tile thumbnail for printerId
 * has changed server-side, refetch the TanStack query".
 *
 * Mirrors the pattern from `print-jobs-invalidator.composable`. The socket
 * service emits when the server sends `printer.thumbnailChanged`; the grid
 * tile subscribes and invalidates its per-printer query so a freshly-started
 * print's preview shows up without waiting for window focus / staleTime.
 */

export interface PrinterThumbnailChangedEvent {
  printerId: number
  jobId?: number
}

export const printerThumbnailChangedKey: EventBusKey<PrinterThumbnailChangedEvent> = Symbol(
  'printer-thumbnail-changed',
)

/** Fire from socket handlers to broadcast a thumbnail-changed signal. */
export function notifyPrinterThumbnailChanged(event: PrinterThumbnailChangedEvent): void {
  useEventBus(printerThumbnailChangedKey).emit(event)
}

/** Subscribe a callback. Auto-unsubscribes on component unmount. */
export function useOnPrinterThumbnailChanged(
  handler: (event: PrinterThumbnailChangedEvent) => void | Promise<void>,
): void {
  const bus = useEventBus(printerThumbnailChangedKey)
  const unsubscribe = bus.on(handler)
  onMounted(() => {
    /* no-op; subscription was set up at composable call time */
  })
  onUnmounted(() => {
    unsubscribe()
  })
}
