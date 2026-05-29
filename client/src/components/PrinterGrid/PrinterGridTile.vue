<template>
  <div v-drop-printer-position="{ x, y, printerSet: printer }">
    <v-card
      v-drop-upload="{ printers: [printer] }"
      :draggable="!!printer"
      :ripple="isOnline"
      :class="{
        'pg-tile--large': largeTilesEnabled,
        'pg-tile--selected': selected,
        'pg-tile--unselected': unselected,
        'pg-tile--empty': !printer,
        'pg-tile--draggable': !!printer,
        'pg-tile--offline': !!printer && !isOnline,
        'pg-tile--maintenance': !!printer?.disabledReason
      }"
      class="pg-tile rounded-lg"
      :style="!!printer ? { '--state-color': printerStateColor } : undefined"
      elevation="2"
      @click="selectPrinterPosition()"
      @dragstart="onDragStart"
    >
      <!-- ─── EMPTY SLOT ────────────────────────────────────────── -->
      <div
        v-if="!printer"
        :class="isFirstTile && noPrintersExist ? 'pg-tile__add--always' : 'pg-tile__add--hover'"
        class="pg-tile__add"
      >
        <PrinterCreateAction
          :floor-id="floorStore.selectedFloor?.id"
          :floor-x="x"
          :floor-y="y"
          :is-first-time="isFirstTile && noPrintersExist"
        />
      </div>

      <!-- ─── POPULATED TILE ────────────────────────────────────── -->
      <template v-else>
        <!-- State accent strip on the left -->
        <span class="pg-tile__accent" />

        <!-- Liveness pulse: shown when fresh socket events keep arriving.
             Fades out as the stream goes stale, disappears past ~2 minutes. -->
        <span
          v-if="livenessClass"
          :class="['pg-tile__pulse', livenessClass]"
          :title="`Last update ${livenessAgeSeconds}s ago`"
        />

        <!-- Top row: name + quick actions -->
        <header class="pg-tile__header">
          <span
            class="pg-tile__name pg-tile__name--clickable text-truncate"
            :title="`${printer.name} — click to view print history`"
            @click.stop.prevent="detailOpen = true"
          >
            {{ printer.name }}
          </span>
          <div class="pg-tile__quick-actions" @click.stop>
            <v-btn
              variant="tonal"
              color="primary"
              size="x-small"
              density="comfortable"
              icon
              class="pg-tile__qa-btn"
              @click.prevent.stop="clickInfo()"
            >
              <v-icon size="16">folder</v-icon>
              <v-tooltip activator="parent" location="top">Files</v-tooltip>
            </v-btn>
            <v-btn
              variant="tonal"
              color="info"
              size="x-small"
              density="comfortable"
              icon
              class="pg-tile__qa-btn"
              @click.prevent.stop="clickShowCurrentJob()"
            >
              <v-icon size="16">work</v-icon>
              <v-tooltip activator="parent" location="top">Jobs</v-tooltip>
            </v-btn>
            <v-btn
              :disabled="!isOnline || !isOperational"
              variant="tonal"
              size="x-small"
              density="comfortable"
              icon
              class="pg-tile__qa-btn"
              @click.prevent.stop="clickOpenPrinterControlDialog()"
            >
              <v-icon size="16">open_with</v-icon>
              <v-tooltip activator="parent" location="top">Move &amp; home</v-tooltip>
            </v-btn>
            <v-btn
              variant="tonal"
              size="x-small"
              density="comfortable"
              icon
              class="pg-tile__qa-btn"
              @click.prevent.stop="clickOpenSettings()"
            >
              <v-icon size="16">settings</v-icon>
              <v-tooltip activator="parent" location="top">Settings</v-tooltip>
            </v-btn>
          </div>
        </header>

        <!-- Attention strip: visible whenever this printer needs the user
             (ATTENTION, error, maintenance, auth-fail, disconnected). -->
        <div
          v-if="attention.needsAttention"
          :class="['pg-tile__attention', `pg-tile__attention--${attention.severity}`]"
          :title="attention.message + (attention.hint ? '\n\n' + attention.hint : '')"
        >
          <v-icon size="14" class="pg-tile__attention-icon">
            {{ attention.icon }}
          </v-icon>
          <strong class="pg-tile__attention-title">{{ attention.title }}</strong>
          <span class="pg-tile__attention-msg text-truncate">
            {{ attention.message }}
          </span>
        </div>

        <!-- Body: thumbnail + info -->
        <div class="pg-tile__body">
          <div
            class="pg-tile__thumb"
            :class="{ 'pg-tile__thumb--clickable': thumbnail?.length }"
            :title="thumbnail?.length ? 'View larger preview' : undefined"
            @click.stop.prevent="thumbnail?.length && (previewOpen = true)"
          >
            <v-img
              v-if="isOnline && thumbnail?.length"
              :src="'data:image/png;base64,' + (thumbnail ?? '')"
              :width="tileIconThumbnailSize"
              :height="tileIconThumbnailSize"
              cover
            />
            <v-img
              v-else-if="isOnline"
              :src="logoPng"
              :width="tileIconThumbnailSize"
              :height="tileIconThumbnailSize"
              class="pg-tile__thumb--placeholder"
            />
            <v-icon
              v-else-if="printerState?.text.includes('API')"
              :size="tileIconThumbnailSize"
              color="medium-emphasis"
            >
              wifi_off
            </v-icon>
            <v-icon
              v-else-if="!printer.enabled"
              :size="tileIconThumbnailSize"
              color="medium-emphasis"
            >
              disabled_by_default
            </v-icon>
            <v-icon
              v-else
              :size="tileIconThumbnailSize"
              color="medium-emphasis"
            >
              question_mark
            </v-icon>
          </div>

          <div class="pg-tile__info">
            <div
              class="pg-tile__filename text-truncate"
              :title="currentPrintingFilePath ?? 'No file'"
            >
              {{ currentPrintingFilePath ?? 'No file' }}
            </div>

            <v-progress-linear
              v-if="uploadProgress"
              :model-value="uploadProgress.percent"
              :indeterminate="uploadProgress.percent === 0"
              color="info"
              bg-color="rgba(255,255,255,0.08)"
              height="5"
              rounded
              striped
              class="pg-tile__progress"
              :title="`Transferring · ${uploadProgress.percent}% · ${uploadProgress.fileName}`"
            />
            <v-progress-linear
              v-else-if="currentProgress !== undefined"
              :model-value="currentProgress"
              :color="progressBarColor"
              bg-color="rgba(255,255,255,0.08)"
              height="5"
              rounded
              class="pg-tile__progress"
            />

            <div class="pg-tile__meta">
              <v-tooltip
                :disabled="!printer?.disabledReason"
                location="top"
                :text="printer?.disabledReason ?? ''"
              >
                <template #activator="{ props }">
                  <v-chip
                    v-bind="props"
                    :color="chipColor"
                    size="x-small"
                    variant="flat"
                    density="comfortable"
                    class="pg-tile__chip"
                  >
                    <v-icon
                      v-if="printer?.disabledReason"
                      size="x-small"
                      start
                    >
                      construction
                    </v-icon>
                    {{ printer?.disabledReason ? 'Maintenance' : (printerState?.text || '—') }}<template v-if="lastSeenAgoFormatted"> · {{ lastSeenAgoFormatted }}</template>
                  </v-chip>
                </template>
              </v-tooltip>

              <span
                v-if="uploadProgress"
                class="pg-tile__percent"
                title="Transferring file to printer"
              >
                ↑ {{ uploadProgress.percent }}%
              </span>
              <span
                v-else-if="currentProgress !== undefined"
                class="pg-tile__percent"
              >
                {{ currentProgress.toFixed(1) }}%
              </span>

              <span
                v-if="!uploadProgress && timeRemainingFormatted"
                class="pg-tile__eta"
                :title="etaClockFormatted ? `Done at ${etaClockFormatted}` : 'Estimated time remaining'"
              >
                · {{ timeRemainingFormatted }}<template v-if="etaClockFormatted"> · {{ etaClockFormatted }}</template>
              </span>

              <v-spacer />

              <span v-if="toolTemp" class="pg-tile__temp" title="Tool temperature">
                🔥 {{ toolTemp }}
              </span>
              <span v-if="bedTemp" class="pg-tile__temp" title="Bed temperature">
                🛏 {{ bedTemp }}
              </span>
            </div>
          </div>
        </div>

        <!-- Hover overlay: print-state actions. Backdrop has pointer-events:none
             so clicks on empty space pass through to select the tile. -->
        <div class="pg-tile__controls">
          <v-tooltip
            v-if="hasSerialConnection(printer.printerType) && !isOperational && isOnline"
            location="top"
            text="Connect USB"
          >
            <template #activator="{ props }">
              <v-btn
                size="small"
                variant="elevated"
                color="success"
                icon
                v-bind="props"
                @click.prevent.stop="clickConnectUsb()"
              >
                <v-icon>usb</v-icon>
              </v-btn>
            </template>
          </v-tooltip>

          <v-tooltip
            v-if="hasPrinterControl(printer.printerType)"
            location="top"
            text="Refresh connection"
          >
            <template #activator="{ props }">
              <v-btn
                size="small"
                variant="elevated"
                color="surface-variant"
                icon
                v-bind="props"
                @click.prevent.stop="clickRefreshSocket()"
              >
                <v-icon>refresh</v-icon>
              </v-btn>
            </template>
          </v-tooltip>

          <v-tooltip
            v-if="hasPrinterControl(printer.printerType)"
            location="top"
            :text="isPaused ? 'Resume print' : 'Pause print'"
          >
            <template #activator="{ props }">
              <v-btn
                :disabled="!isOnline || (!isPaused && !isPrinting)"
                size="small"
                variant="elevated"
                :color="isPaused ? 'success' : 'warning'"
                icon
                v-bind="props"
                @click.prevent.stop="isPaused ? clickResumePrint() : clickPausePrint()"
              >
                <v-icon>{{ isPaused ? 'play_arrow' : 'pause' }}</v-icon>
              </v-btn>
            </template>
          </v-tooltip>

          <v-tooltip
            v-if="hasPrinterControl(printer.printerType) && (hasEmergencyStop(printer.printerType) || preferCancelOverQuickStop)"
            location="top"
            :text="preferCancelOverQuickStop ? 'Cancel print' : 'Emergency stop'"
          >
            <template #activator="{ props }">
              <v-btn
                :disabled="!isOnline || (preferCancelOverQuickStop && !isPrinting && !isPaused)"
                size="small"
                variant="elevated"
                color="error"
                icon
                v-bind="props"
                @click.prevent.stop="preferCancelOverQuickStop ? clickStop() : clickQuickStop()"
              >
                <v-icon>{{ preferCancelOverQuickStop ? 'stop' : 'dangerous' }}</v-icon>
              </v-btn>
            </template>
          </v-tooltip>
        </div>
      </template>
    </v-card>

    <PrinterTilePreviewDialog
      v-model="previewOpen"
      :printer-name="printer?.name"
      :file-name="previewFileName"
      :thumbnail="thumbnail"
      :estimated-seconds="previewEstimatedSeconds"
      :remaining-seconds="timeRemainingSeconds"
      :metadata="previewMetadata"
    />

    <PrinterDetailDialog
      v-model="detailOpen"
      :printer-id="printerId"
    />
  </div>
</template>

<script lang="ts" setup>
import { computed, ref, PropType } from 'vue'
import { useIntervalFn } from '@vueuse/core'
import { derivePrinterAttention } from '@/shared/printer-attention.util'
import { notifyPrintJobsChanged } from '@/shared/print-jobs-invalidator.composable'
import { confirm as confirmDialog } from '@/shared/confirm-dialog.composable'
import { useRouter } from 'vue-router'
import { PrintersService } from '@/backend'
import { usePrinterStore } from '@/store/printer.store'
import { DialogName } from '@/components/Generic/Dialogs/dialog.constants'
import { useSettingsStore } from '@/store/settings.store'
import { useFloorStore } from '@/store/floor.store'
import { interpretStates } from '@/shared/printer-state.constants'
import { usePrinterStateStore } from '@/store/printer-state.store'
import { PrinterDto } from '@/models/printers/printer.model'
import { useSnackbar } from '@/shared/snackbar.composable'
import { useDialog } from '@/shared/dialog.composable'
import { usePrinterTileThumbnailQuery, printerTileThumbnailQueryKey } from '@/queries/printer-tile-thumbnail.query'
import { useOnPrinterThumbnailChanged } from '@/shared/printer-thumbnail-invalidator.composable'
import { useQueryClient } from '@tanstack/vue-query'
import PrinterTilePreviewDialog from './PrinterTilePreviewDialog.vue'
import PrinterDetailDialog from './PrinterDetailDialog.vue'
import { useFileExplorer } from '@/shared/file-explorer.composable'
import { dragAppId, INTENT, PrinterPlace, DRAG_EVENTS } from '@/shared/drag.constants'
import { hasEmergencyStop, hasPrinterControl, hasSerialConnection } from '@/shared/printer-capabilities.constants'
import logoPng from '@/assets/logo.png'

const defaultColor = 'rgba(100,100,100,0.1)'

const props = defineProps({
  printer: {
    type: Object as PropType<PrinterDto | undefined>,
    required: false
  },
  x: { type: Number, required: true },
  y: { type: Number, required: true }
})

const printerStore = usePrinterStore()
const printerStateStore = usePrinterStateStore()
const floorStore = useFloorStore()
const settingsStore = useSettingsStore()
const controlDialog = useDialog(DialogName.PrinterControlDialog)
const addOrUpdateDialog = useDialog(DialogName.AddOrUpdatePrinterDialog)
const fileExplorer = useFileExplorer()
const snackbar = useSnackbar()
const router = useRouter()

const printerId = computed(() => props.printer?.id)

const isFirstTile = computed(() => props.x === 0 && props.y === 0)
const noPrintersExist = computed(() => printerStore.printers.length === 0)

const largeTilesEnabled = computed(() => settingsStore.largeTiles)
const tileIconThumbnailSize = computed(() =>
  largeTilesEnabled.value ? '80px' : '40px'
)

const { data: thumbnailRecord } = usePrinterTileThumbnailQuery(printerId)
const thumbnail = computed(() => thumbnailRecord.value?.thumbnailBase64 ?? '')

// Refetch the per-printer thumbnail when the server signals it changed
// (a new print just started). Without this, the TanStack cache stays
// pinned to the previous print's preview until window focus refresh.
const queryClient = useQueryClient()
useOnPrinterThumbnailChanged((event) => {
  if (event.printerId === printerId.value) {
    queryClient.invalidateQueries({ queryKey: [printerTileThumbnailQueryKey, printerId] })
  }
})

const previewOpen = ref(false)
const detailOpen = ref(false)
const previewMetadata = computed(() => thumbnailRecord.value?.job?.metadata ?? null)
const previewEstimatedSeconds = computed(() => thumbnailRecord.value?.job?.estimatedSeconds ?? null)
const previewFileName = computed(
  () => thumbnailRecord.value?.fileName ?? thumbnailRecord.value?.job?.fileName ?? currentPrintingFilePath.value ?? null,
)

const isOnline = computed(() =>
  printerId.value ? printerStateStore.isApiResponding(printerId.value) : false
)

const isOperational = computed(() =>
  printerId.value
    ? printerStateStore.isPrinterOperational(printerId.value)
    : false
)

const isPrinting = computed(() => {
  return printerId.value
    ? printerStateStore.isPrinterPrinting(printerId.value)
    : false
})

const isPaused = computed(() => {
  if (!printerId.value) return false

  return printerStateStore.isPrinterPaused(printerId.value)
})

const selected = computed(() => {
  if (!printerId.value) return false
  return printerStore.isSelectedPrinter(printerId.value)
})

const unselected = computed(() => {
  return printerStore.selectedPrinters?.length && !selected.value
})

const preferCancelOverQuickStop = computed(() => {
  return settingsStore.preferCancelOverQuickStop
})

const printerState = computed(() => {
  if (!printerId.value) return
  const printer = printerStore.printer(printerId.value)
  if (!printer) return

  const printerEvents = printerStateStore.printerEventsById[printerId.value]
  const socketState = printerStateStore.socketStatesById[printerId.value]
  return interpretStates(printer, socketState, printerEvents)
})

const printerStateColor = computed(() => {
  const states = printerState.value
  if (!states) {
    return defaultColor
  }
  return states.rgb || defaultColor
})

// Liveness derived from the socket-event timestamp. We tick a local clock
// every 5s so the pulse fades out even when no new event arrives.
const nowMs = ref(Date.now())
useIntervalFn(() => {
  nowMs.value = Date.now()
}, 5000)

const lastEventAtMs = computed(() => {
  if (!printerId.value) return 0
  return printerStateStore.printerCurrentEventReceivedAtById[printerId.value] ?? 0
})

const livenessAgeSeconds = computed(() => {
  if (!lastEventAtMs.value) return Number.POSITIVE_INFINITY
  return Math.floor((nowMs.value - lastEventAtMs.value) / 1000)
})

const livenessClass = computed(() => {
  const age = livenessAgeSeconds.value
  if (age < 30) return 'pg-tile__pulse--fresh'
  if (age < 120) return 'pg-tile__pulse--warm'
  return null
})

const attention = computed(() => {
  if (!props.printer) return derivePrinterAttention(undefined, undefined, undefined)
  return derivePrinterAttention(
    props.printer,
    printerId.value ? printerStateStore.printerEventsById[printerId.value] : undefined,
    printerId.value ? printerStateStore.socketStatesById[printerId.value] : undefined,
  )
})

const chipColor = computed(() => {
  if (props.printer?.disabledReason) return 'warning'
  if (!isOnline.value) return 'grey'
  if (isPaused.value) return 'warning'
  if (isPrinting.value) return 'success'
  if (isOperational.value) return 'primary'
  return undefined
})

const progressBarColor = computed(() => {
  if (isPaused.value) return 'warning'
  if (isPrinting.value) return 'success'
  return 'primary'
})

const currentJob = computed(() => {
  if (!printerId.value) return
  return printerStateStore.printerJobsById[printerId.value]
})

const currentProgress = computed(() => {
  if (!printerId.value) return undefined

  const job = currentJob.value
  return job?.progress?.completion
})

// Queue dispatch transfer progress for this printer. Populated server-side
// while a STARTING-status job's PUT is streaming to PrusaLink — the
// printer itself reports IDLE during the upload, so `currentProgress`
// (which reads the firmware's print progress) is unset. We display this
// instead so the user knows the upload is alive and how close to done.
const uploadProgress = computed<{ percent: number; fileName: string } | null>(() => {
  if (!printerId.value) return null
  const entry = printerStateStore.queueUploadsByPrinterId[printerId.value]
  if (!entry) return null
  const pct = entry.progress === null ? 0 : Math.round(entry.progress * 100)
  return { percent: pct, fileName: entry.fileName }
})

const timeRemainingSeconds = computed<number | null>(() => {
  if (!printerId.value) return null
  // PrusaLink reports `printTimeLeft` (seconds) in the polled progress payload
  // — see prusa-link-http-polling.adapter.ts. Zero / negative is treated as
  // "unknown" since the firmware reports 0 both when finished and when the
  // slicer didn't include an estimate.
  const value = currentJob.value?.progress?.printTimeLeft
  return typeof value === 'number' && value > 0 ? value : null
})

// Compact "h/m" form so it fits next to the percent without truncating the
// chip or temperatures on smaller tiles. Seconds-only when the print is in
// its last minute — anywhere else it's noise that flickers every poll.
const timeRemainingFormatted = computed<string | null>(() => {
  const total = timeRemainingSeconds.value
  if (total === null) return null
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (hours > 0) return `${ hours }h ${ minutes }m`
  if (minutes > 0) return `${ minutes }m`
  return `${ Math.floor(total) }s`
})

// Wall-clock ETA — operators reading the grid in a busy workshop find
// "done at 16:42" more actionable than "1h 24m" abstract. When the print
// crosses midnight, append the day-after marker so 02:15 doesn't look
// like it's about to happen.
const etaClockFormatted = computed<string | null>(() => {
  const remaining = timeRemainingSeconds.value
  if (remaining === null) return null
  const eta = new Date(Date.now() + remaining * 1000)
  const hh = String(eta.getHours()).padStart(2, '0')
  const mm = String(eta.getMinutes()).padStart(2, '0')
  const sameDay = eta.toDateString() === new Date().toDateString()
  return sameDay ? `${hh}:${mm}` : `${hh}:${mm} +1d`
})

// "Last seen Xm ago" hint for offline/unreachable printers. The
// store exposes the last successful poll's timestamp; if we've never
// heard from this printer (fresh add, never online) the hint is
// suppressed so the chip just reads "Offline".
const lastSeenAgoFormatted = computed<string | null>(() => {
  if (!printerId.value || isOnline.value) return null
  const ts = printerStateStore.printerCurrentEventReceivedAtById[printerId.value]
  if (!ts) return null
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
})

const currentPrintingFilePath = computed(() => {
  if (!printerId.value) return
  return printerStateStore.printingFilePathsByPrinterId[printerId.value]
})

const currentTemperatures = computed(() => {
  if (!printerId.value) return null
  const printerEvents = printerStateStore.printerEventsById[printerId.value]
  if (!printerEvents?.current?.payload?.temps || printerEvents.current.payload.temps.length === 0) {
    return null
  }
  // Get the most recent temperature reading
  return printerEvents.current.payload.temps[printerEvents.current.payload.temps.length - 1]
})

const toolTemp = computed(() => {
  const temps = currentTemperatures.value
  return temps?.tool0 ? `${Math.round(temps.tool0.actual)}°/${Math.round(temps.tool0.target)}°` : null
})

const bedTemp = computed(() => {
  const temps = currentTemperatures.value
  return temps?.bed ? `${Math.round(temps.bed.actual)}°/${Math.round(temps.bed.target)}°` : null
})

const clickStop = async () => {
  if (!printerId.value) return

  await printerStore.sendStopJobCommand(printerId.value)
  notifyPrintJobsChanged({ printerId: printerId.value, reason: 'tile:stop' })
}

const clickPausePrint = async () => {
  if (!printerId.value) return

  await PrintersService.pausePrintJob(printerId.value)
  notifyPrintJobsChanged({ printerId: printerId.value, reason: 'tile:pause' })
}

const clickResumePrint = async () => {
  if (!printerId.value) return

  await PrintersService.resumePrintJob(printerId.value)
  notifyPrintJobsChanged({ printerId: printerId.value, reason: 'tile:resume' })
}

const clickInfo = () => {
  if (!props.printer) return
  fileExplorer.openFileExplorer(props.printer)
}

const clickRefreshSocket = async () => {
  if (!printerId.value) return
  await PrintersService.refreshSocket(printerId.value)
  snackbar.openInfoMessage({
    title: 'Refreshing connection state'
  })
}

const onDragStart = (ev: DragEvent) => {
  if (!ev.dataTransfer || !props.printer?.id) return

  // Notify that we're dragging a placed printer (for showing remove zone)
  globalThis.dispatchEvent(new CustomEvent(DRAG_EVENTS.TILE_DRAG_START))

  ev.dataTransfer.setData(
    'text',
    JSON.stringify({
      appId: dragAppId,
      intent: INTENT.PRINTER_PLACE,
      printerId: props.printer.id
    } as PrinterPlace)
  )
}

const clickOpenSettings = () => {
  const printer = props.printer
  if (!printer) return
  addOrUpdateDialog.openDialog({ id: printer.id })
}

const clickShowCurrentJob = async () => {
  if (!printerId.value) {
    snackbar.openInfoMessage({
      title: 'No Printer',
      subtitle: 'No printer to find jobs for'
    })
    return
  }

  await router.push({
    path: '/jobs',
    query: { printerId: printerId.value.toString() }
  })
}

const clickOpenPrinterControlDialog = async () => {
  if (!printerId.value || !props.printer) {
    throw new Error('PrinterId not set, cant open dialog')
  }

  await controlDialog.openDialog({ printer: props.printer })
}

const clickQuickStop = async () => {
  if (!printerId.value) return

  const ok = await confirmDialog({
    title: 'Emergency stop?',
    message:
      'This sends M112 to the printer — it will abort the print immediately and disable steppers/heaters.',
    hint: 'You will need to reconnect the printer afterwards.',
    confirmText: 'Emergency stop',
    cancelText: 'Cancel',
    severity: 'danger',
    icon: 'dangerous',
  })
  if (!ok) return

  await PrintersService.postQuickStopM112Command(printerId.value)
  notifyPrintJobsChanged({ printerId: printerId.value, reason: 'tile:quick-stop' })
}

const clickConnectUsb = async () => {
  if (!printerId.value) return
  await PrintersService.sendPrinterConnectCommand(printerId.value)
}

const selectPrinterPosition = async () => {
  if (!props.printer || !printerId.value) {
    return
  }

  printerStore.toggleSelectedPrinter(props.printer)
}
</script>

<style scoped>
/* ─── Tile container ─────────────────────────────────────────── */
.pg-tile {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 96px;
  padding: 8px 10px 8px 14px;
  background: rgb(var(--v-theme-surface));
  color: rgb(var(--v-theme-on-surface));
  overflow: hidden;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}

.pg-tile--large {
  min-height: 130px;
}

.pg-tile--draggable {
  cursor: pointer;
}

.pg-tile--draggable:active {
  cursor: grabbing;
  opacity: 0.7;
}

.pg-tile--selected {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: -2px;
}

.pg-tile--unselected {
  opacity: 0.55;
}

.pg-tile--offline {
  opacity: 0.78;
}

/* ─── State accent stripe (left edge) ────────────────────────── */
.pg-tile__accent {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 4px;
  background: var(--state-color, rgba(255, 255, 255, 0.1));
}

/* Liveness pulse — small dot under the accent strip in the top-left
   corner. Fresh = pulsing green-ish; warm = static dimmer dot. */
.pg-tile__pulse {
  position: absolute;
  top: 6px;
  left: 8px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  z-index: 1;
  pointer-events: none;
}

.pg-tile__pulse--fresh {
  background: rgb(var(--v-theme-success));
  box-shadow: 0 0 0 0 rgba(var(--v-theme-success), 0.6);
  animation: pg-tile-pulse 1.6s ease-out infinite;
}

.pg-tile__pulse--warm {
  background: rgba(var(--v-theme-on-surface), 0.4);
}

@keyframes pg-tile-pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(var(--v-theme-success), 0.55);
  }
  70% {
    box-shadow: 0 0 0 8px rgba(var(--v-theme-success), 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(var(--v-theme-success), 0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .pg-tile__pulse--fresh {
    animation: none;
  }
}

/* ─── Empty (no-printer) tile ────────────────────────────────── */
.pg-tile--empty {
  min-height: 96px;
  border: 1.5px dashed rgba(var(--v-theme-on-surface), 0.18);
  background: transparent;
  align-items: center;
  justify-content: center;
  padding: 0;
}

.pg-tile--empty:hover {
  background: rgba(var(--v-theme-on-surface), 0.04);
  border-color: rgba(var(--v-theme-on-surface), 0.32);
}

.pg-tile__add {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
}

.pg-tile__add--hover {
  opacity: 0;
  transition: opacity 0.15s ease;
}

.pg-tile--empty:hover .pg-tile__add--hover {
  opacity: 1;
}

.pg-tile__add--always {
  opacity: 1;
}

/* ─── Header (name + quick actions) ──────────────────────────── */
.pg-tile__header {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.pg-tile__name {
  font-size: 14px;
  font-weight: 600;
  flex: 1 1 auto;
  min-width: 0;
}

.pg-tile__name--clickable {
  cursor: pointer;
}

.pg-tile__name--clickable:hover {
  text-decoration: underline;
  text-underline-offset: 2px;
  text-decoration-color: rgba(var(--v-theme-primary), 0.5);
}

.pg-tile__quick-actions {
  display: flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
}

.pg-tile__qa-btn {
  /* Slightly bigger hit target than default x-small, keeping the row tight. */
  width: 26px !important;
  height: 26px !important;
}

/* ─── Body (thumbnail + info) ────────────────────────────────── */
.pg-tile__body {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1 1 auto;
  min-width: 0;
  margin-top: 4px;
}

.pg-tile__thumb {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  overflow: hidden;
}

.pg-tile__thumb--placeholder {
  opacity: 0.25;
  filter: grayscale(100%);
}

.pg-tile__thumb--clickable {
  cursor: zoom-in;
  transition: transform 120ms ease;
}

.pg-tile__thumb--clickable:hover {
  transform: scale(1.04);
}

.pg-tile__info {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.pg-tile__filename {
  font-size: 11.5px;
  color: rgba(var(--v-theme-on-surface), 0.85);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.pg-tile__progress {
  margin: 2px 0;
}

.pg-tile__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 10.5px;
  line-height: 1.2;
  color: rgba(var(--v-theme-on-surface), 0.7);
}

.pg-tile__chip {
  font-size: 10px !important;
  font-weight: 700;
  letter-spacing: 0.04em;
  height: 18px !important;
  padding: 0 6px !important;
}

.pg-tile__percent {
  font-weight: 700;
  color: rgb(var(--v-theme-on-surface));
}

.pg-tile__eta {
  font-weight: 500;
  color: rgba(var(--v-theme-on-surface), 0.72);
  white-space: nowrap;
}

.pg-tile__temp {
  white-space: nowrap;
}

/* ─── Hover controls cluster (bottom-right, no backdrop) ─────── */
.pg-tile__controls {
  position: absolute;
  bottom: 8px;
  right: 8px;
  display: flex;
  align-items: center;
  gap: 4px;
  opacity: 0;
  transform: translateY(4px);
  pointer-events: none;
  transition: opacity 0.15s ease, transform 0.15s ease;
  z-index: 2;
}

.pg-tile__controls > * {
  pointer-events: none;
}

.pg-tile:hover .pg-tile__controls,
.pg-tile:focus-within .pg-tile__controls {
  opacity: 1;
  transform: translateY(0);
}

.pg-tile:hover .pg-tile__controls > *,
.pg-tile:focus-within .pg-tile__controls > * {
  pointer-events: auto;
}

/* ─── Attention strip ────────────────────────────────────────── */
.pg-tile__attention {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  margin: 2px 0 6px;
  border-radius: 6px;
  font-size: 11px;
  line-height: 1.25;
  min-width: 0;
  cursor: help;
}

.pg-tile__attention--critical {
  background: rgba(var(--v-theme-error), 0.14);
  color: rgb(var(--v-theme-error));
  animation: pg-attention-pulse 2.6s ease-in-out infinite;
}

.pg-tile__attention--warning {
  background: rgba(var(--v-theme-warning), 0.14);
  color: rgb(var(--v-theme-warning));
}

.pg-tile__attention--info {
  background: rgba(var(--v-theme-info), 0.12);
  color: rgb(var(--v-theme-info));
}

.pg-tile__attention-icon {
  flex-shrink: 0;
}

.pg-tile__attention-title {
  flex-shrink: 0;
  text-transform: uppercase;
  font-size: 10px;
  letter-spacing: 0.04em;
  font-weight: 700;
}

.pg-tile__attention-msg {
  flex: 1 1 auto;
  min-width: 0;
  font-weight: 500;
  opacity: 0.92;
}

@keyframes pg-attention-pulse {
  0%, 100% { background: rgba(var(--v-theme-error), 0.12); }
  50% { background: rgba(var(--v-theme-error), 0.22); }
}

@media (prefers-reduced-motion: reduce) {
  .pg-tile__attention--critical { animation: none; }
}

/* Maintenance state visual cue */
.pg-tile--maintenance {
  background: linear-gradient(
    135deg,
    rgb(var(--v-theme-surface)) 0%,
    rgba(var(--v-theme-warning), 0.04) 100%
  );
}
</style>
