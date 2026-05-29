import type {
  PrinterStateDto,
  SocketState,
} from '@/models/socketio-messages/socketio-message.model'
import type { PrinterDto } from '@/models/printers/printer.model'

export type AttentionSeverity = 'critical' | 'warning' | 'info'

export interface PrinterAttention {
  /** True when the printer needs human intervention or has a blocking issue. */
  needsAttention: boolean
  /** Visual urgency. Critical => red banner; warning => yellow; info => blue. */
  severity: AttentionSeverity
  /** Short headline for chips / toast titles ("ATTENTION", "Connection lost"…). */
  title: string
  /** Full human-readable message coming from the firmware / backend. */
  message: string
  /** Optional suggestion the UI can render under the message. */
  hint?: string
  /** Icon to pair with the alert (Material Symbols name). */
  icon: string
  /**
   * Discriminator for transition-watchers so they only fire once per entry
   * into a given attention state (e.g. don't re-toast on every socket tick).
   */
  kind:
    | 'attention'
    | 'error'
    | 'maintenance'
    | 'disconnected'
    | 'auth-failure'
    | 'offline'
    | 'paused'
    | 'busy'
    | 'cancelling'
    | 'transferring'
    | 'low-storage'
    | 'hot-idle'
}

/** Free-space threshold (bytes) below which we surface a low-storage warning. */
const LOW_STORAGE_BYTES = 200 * 1024 * 1024 // 200 MB
/** Hotend temp above which an *idle* printer is considered hot enough to warn. */
const HOT_IDLE_TEMP_C = 50

const NONE: PrinterAttention = {
  needsAttention: false,
  severity: 'info',
  title: '',
  message: '',
  icon: 'info',
  kind: 'attention',
}

/**
 * Map a printer's current state to a normalised "attention" descriptor so
 * every consumer (tile, drawer, dashboard, toast watcher) can render the
 * same warning consistently.
 *
 * Order of precedence matches what's most urgent for the operator:
 *   1. Maintenance (configured by the user — informational)
 *   2. Auth failure (won't recover without action)
 *   3. API unreachable (printer or network down)
 *   4. ATTENTION (firmware reason — needs physical intervention)
 *   5. Generic error
 *   6. Paused (informational, not really attention)
 */
export function derivePrinterAttention(
  printer: PrinterDto | undefined,
  printerState: PrinterStateDto | undefined,
  socketState: SocketState | undefined,
): PrinterAttention {
  if (!printer) return NONE

  // ── Maintenance: configured by the user, not a runtime error ──
  if (!printer.enabled && printer.disabledReason?.length) {
    return {
      needsAttention: true,
      severity: 'warning',
      title: 'Under maintenance',
      message: printer.disabledReason,
      icon: 'construction',
      kind: 'maintenance',
    }
  }

  // Disabled but no reason given = user just turned it off → not an issue.
  if (!printer.enabled) return NONE

  const apiState = socketState?.api
  if (apiState === 'authFail') {
    return {
      needsAttention: true,
      severity: 'critical',
      title: 'API key rejected',
      message: 'The printer rejected the saved API key.',
      hint: 'Update the credentials in printer settings, then refresh the connection.',
      icon: 'vpn_key_off',
      kind: 'auth-failure',
    }
  }

  if (apiState === 'noResponse') {
    return {
      needsAttention: true,
      severity: 'warning',
      title: 'Unreachable',
      message: 'No response from the printer host.',
      hint: 'Check power, network and the printer URL.',
      icon: 'wifi_off',
      kind: 'disconnected',
    }
  }

  if (apiState && apiState !== 'responding') {
    return {
      needsAttention: true,
      severity: 'warning',
      title: 'Connection issue',
      message: `Printer API reported: ${apiState}`,
      icon: 'sync_problem',
      kind: 'disconnected',
    }
  }

  // ── Flag-driven states ──
  const current = printerState?.current?.payload?.state
  const flags = current?.flags
  if (!flags) return NONE

  const text = current?.text ?? ''
  const upper = text.toUpperCase()

  // PrusaLink surfaces ATTENTION with the firmware message attached as
  // "ATTENTION: <reason>". Pluck the reason for a cleaner banner.
  if (upper.startsWith('ATTENTION')) {
    const reason = text.replace(/^ATTENTION:?\s*/i, '').trim()
    return {
      needsAttention: true,
      severity: 'critical',
      title: 'Needs attention',
      message: reason || 'The printer paused and is waiting on you.',
      hint: 'Resolve the issue on the printer\'s front panel, then resume.',
      icon: 'warning_amber',
      kind: 'attention',
    }
  }

  if (flags.error || flags.closedOrError) {
    // The polling adapter mirrors PrusaLink's `status_printer.message` to
    // `payload.printerMessage`. For errors that field is typically more
    // descriptive than the bare state.text ("Heater fault: short circuit
    // on tool 0" vs just "Error") — prefer it when present.
    const firmwareMessage = (printerState?.current?.payload as any)?.printerMessage
    return {
      needsAttention: true,
      severity: 'critical',
      title: 'Error',
      message:
        firmwareMessage ||
        text ||
        (current as any)?.error ||
        'The printer reported an error.',
      icon: 'error',
      kind: 'error',
    }
  }

  if (flags.cancelling) {
    return {
      needsAttention: true,
      severity: 'info',
      title: 'Cancelling',
      message: text || 'The current print is being cancelled.',
      icon: 'cancel',
      kind: 'cancelling',
    }
  }

  if (flags.paused || flags.pausing) {
    return {
      needsAttention: true,
      severity: 'info',
      title: 'Paused',
      message: text || 'Print is paused.',
      icon: 'pause_circle',
      kind: 'paused',
    }
  }

  // ── File transfer in progress (PrusaLink streams the gcode up to the
  // printer before it can be started — surface that so it doesn't look
  // like nothing is happening). ──
  const payload = printerState?.current?.payload as any
  const transfer = payload?.transfer
  if (transfer && typeof transfer.progress === 'number' && transfer.progress < 1) {
    const percent = Math.round(transfer.progress * 100)
    return {
      needsAttention: true,
      severity: 'info',
      title: 'Transferring file',
      message: `Uploading to printer · ${percent}%`,
      hint: 'Print will start automatically once the file finishes streaming.',
      icon: 'cloud_upload',
      kind: 'transferring',
    }
  }

  // ── Storage running low. Only meaningful when the printer reports
  // free space at all (some firmwares don't). Threshold picked so the
  // user has time to clear space before a job upload fails. ──
  const freeSpace: number | null | undefined = payload?.freeSpace
  if (
    typeof freeSpace === 'number' &&
    freeSpace > 0 &&
    freeSpace < LOW_STORAGE_BYTES
  ) {
    return {
      needsAttention: true,
      severity: 'warning',
      title: 'Low storage',
      message: `Only ${formatBytes(freeSpace)} free on the printer.`,
      hint: 'Delete files from the printer to free space.',
      icon: 'storage',
      kind: 'low-storage',
    }
  }

  // ── BUSY: heating, levelling, calibrating, etc. Informational but
  // worth showing so the user understands why nothing else can run.
  // (`busy` is added by the PrusaLink adapter but isn't in the shared
  // flags typing yet, hence the cast.) ──
  if ((flags as any).busy) {
    return {
      needsAttention: true,
      severity: 'info',
      title: 'Busy',
      message: text || 'Printer is busy (heating, levelling or calibrating).',
      icon: 'hourglass_top',
      kind: 'busy',
    }
  }

  // ── Hot but idle: hotend is warm and there's no print active. Safety
  // hint so the user remembers to either start a print or let it cool. ──
  const tempsList = payload?.temps as any[] | undefined
  if (
    !flags.printing &&
    !flags.paused &&
    !flags.pausing &&
    tempsList?.length
  ) {
    const latest = tempsList[tempsList.length - 1]
    const toolActual = latest?.tool0?.actual ?? latest?.tool1?.actual ?? 0
    const toolTarget = latest?.tool0?.target ?? 0
    if (toolActual >= HOT_IDLE_TEMP_C && toolTarget < HOT_IDLE_TEMP_C) {
      return {
        needsAttention: true,
        severity: 'info',
        title: 'Hot & idle',
        message: `Hotend still at ${Math.round(toolActual)}°C with no active print.`,
        hint: 'Start a print or wait for it to cool down.',
        icon: 'whatshot',
        kind: 'hot-idle',
      }
    }
  }

  return NONE
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}
