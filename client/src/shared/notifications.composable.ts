import { ref, computed, readonly } from 'vue'

/**
 * Browser-notification preference + permission state.
 *
 * Notifications are opt-in (stored in localStorage as a hard "yes"); we
 * don't auto-request permission just because the dashboard is open.
 * Two-axis state:
 *   - `enabled`     — user clicked the toggle in Grid Settings.
 *   - `permission`  — the browser's actual `Notification.permission`.
 * Both have to align for `notify()` to actually fire — toggling off is
 * always honoured (defensive), but toggling on only works when the user
 * granted permission.
 */

const LOCAL_STORAGE_KEY = 'prusahero.browserNotifications.enabled'

const isSupported = typeof window !== 'undefined' && 'Notification' in window

// Module-level state so every component shares the same toggle (and so
// flipping the switch in the menu updates the listener already
// running in socketio.service).
const enabled = ref<boolean>(loadInitialPreference())
const permission = ref<NotificationPermission>(
  isSupported ? Notification.permission : 'denied',
)

function loadInitialPreference(): boolean {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(LOCAL_STORAGE_KEY) === '1'
}

async function ensurePermission(): Promise<NotificationPermission> {
  if (!isSupported) return 'denied'
  if (Notification.permission !== 'default') {
    permission.value = Notification.permission
    return Notification.permission
  }
  // requestPermission resolves with the new state — kept synchronised so
  // the toggle UI can react immediately.
  const next = await Notification.requestPermission()
  permission.value = next
  return next
}

export function useBrowserNotifications() {
  /** Flip the user preference. Requests permission on first opt-in. */
  async function setEnabled(value: boolean): Promise<boolean> {
    if (!isSupported) return false
    if (value) {
      const granted = (await ensurePermission()) === 'granted'
      if (!granted) {
        // Permission was denied — refuse the opt-in so the toggle reflects
        // the actual capability instead of looking enabled while never
        // firing.
        enabled.value = false
        localStorage.setItem(LOCAL_STORAGE_KEY, '0')
        return false
      }
      enabled.value = true
      localStorage.setItem(LOCAL_STORAGE_KEY, '1')
      return true
    }
    enabled.value = false
    localStorage.setItem(LOCAL_STORAGE_KEY, '0')
    return true
  }

  /**
   * Fire a browser notification. No-op if the toggle is off, permission
   * isn't granted, or the browser doesn't support the Notification API.
   * Returns whether anything was shown — handy for tests.
   */
  function notify(
    title: string,
    options?: { body?: string; tag?: string; icon?: string },
  ): boolean {
    if (!isSupported || !enabled.value || permission.value !== 'granted') {
      return false
    }
    try {
      new Notification(title, {
        body: options?.body,
        // `tag` collapses duplicates: a second "Drucker-2 print complete"
        // replaces the first instead of stacking.
        tag: options?.tag,
        icon: options?.icon ?? '/favicon.png',
        silent: false,
      })
      return true
    } catch (e) {
      // Some browsers throw if the page is in an unusable state — log and
      // fall through. We don't want a broken notification to cascade into
      // the socket handler.
      // eslint-disable-next-line no-console
      console.warn('[notifications] failed to dispatch:', e)
      return false
    }
  }

  return {
    isSupported,
    enabled: readonly(enabled),
    permission: readonly(permission),
    canShow: computed(
      () => isSupported && enabled.value && permission.value === 'granted',
    ),
    setEnabled,
    notify,
  }
}
