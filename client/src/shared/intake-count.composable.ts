import { ref } from 'vue'
import { IntakeService } from '@/backend/intake.service'

/**
 * Shared count of pending intake items, used by the nav badge. Kept module-
 * level (not per-component) so the badge and the IntakeView stay in sync. The
 * socket `intake.event` handler calls refresh() on any change.
 */
const pendingCount = ref(0)
let started = false

export function useIntakePendingCount() {
  return pendingCount
}

export async function refreshIntakePendingCount(): Promise<void> {
  try {
    const res = await IntakeService.list()
    pendingCount.value = res.count
  } catch {
    // Leave the last known value on a transient failure.
  }
}

/** Call once after auth so the badge has a value before the first socket event. */
export function ensureIntakeCountStarted(): void {
  if (started) return
  started = true
  void refreshIntakePendingCount()
}
