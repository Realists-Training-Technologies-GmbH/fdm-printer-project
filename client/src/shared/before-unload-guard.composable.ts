import { watch, onUnmounted, type Ref } from 'vue'

/**
 * Warn the user with the browser's native "Leave site?" prompt when they try
 * to close/refresh the tab while `active` is true — e.g. an upload in progress.
 *
 * This can't *save* the in-flight work (closing the tab always kills the
 * request, and JS can't re-read a file after reload), but it prevents the
 * accidental refresh/close that loses it. Only fires while active; the
 * listener is added/removed reactively and torn down on unmount so it never
 * lingers and nags on unrelated pages.
 */
export function useBeforeUnloadGuard(active: Ref<boolean>) {
  const handler = (e: BeforeUnloadEvent) => {
    e.preventDefault()
    // Legacy requirement: some browsers only show the prompt if returnValue
    // is set. The custom string is ignored by modern browsers (they show a
    // generic message), but setting it is what triggers the dialog.
    e.returnValue = ''
  }

  watch(
    active,
    (isActive) => {
      if (isActive) {
        window.addEventListener('beforeunload', handler)
      } else {
        window.removeEventListener('beforeunload', handler)
      }
    },
    { immediate: true },
  )

  onUnmounted(() => {
    window.removeEventListener('beforeunload', handler)
  })
}
