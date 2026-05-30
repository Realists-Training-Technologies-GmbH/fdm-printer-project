import { onUnmounted } from 'vue'
import type { EventBusKey } from '@vueuse/core'
import { useEventBus } from '@vueuse/core'

/**
 * Event bus that broadcasts intake-inbox changes coming from the server's
 * `intake.event` socket message: a file arrived (`created`) or an item was
 * resolved (`resolved`). The IntakeView and the nav badge subscribe to refresh
 * their list/count without polling.
 *
 * Mirrors the printer-thumbnail-invalidator pattern.
 */
export interface IntakeChangedEvent {
  kind: 'created' | 'resolved'
  id: number
  status?: string
}

export const intakeChangedKey: EventBusKey<IntakeChangedEvent> = Symbol('intake-changed')

/** Fire from the socket handler to broadcast an intake-changed signal. */
export function notifyIntakeChanged(event: IntakeChangedEvent): void {
  useEventBus(intakeChangedKey).emit(event)
}

/** Subscribe a callback. Auto-unsubscribes on component unmount. */
export function useOnIntakeChanged(
  handler: (event: IntakeChangedEvent) => void | Promise<void>,
): void {
  const bus = useEventBus(intakeChangedKey)
  const unsubscribe = bus.on(handler)
  onUnmounted(() => {
    unsubscribe()
  })
}
