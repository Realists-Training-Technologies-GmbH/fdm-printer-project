<template>
  <v-dialog
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
    max-width="600"
  >
    <v-card v-if="file">
      <v-card-title class="d-flex align-center">
        <v-icon class="mr-2">add_to_queue</v-icon>
        Queue File to Printers
        <v-spacer />
        <v-btn
          icon="close"
          variant="text"
          @click="$emit('update:modelValue', false)"
        />
      </v-card-title>

      <v-card-text>
        <div class="mb-4">
          <strong>File:</strong>
          {{ displayFileName(file) }}
        </div>

        <div v-if="checkingCompat" class="d-flex justify-center py-6">
          <v-progress-circular indeterminate size="28" />
        </div>

        <template v-else>
          <v-alert
            type="info"
            variant="tonal"
            density="compact"
            class="mb-3"
          >
            Showing only printers compatible with this {{ (file?.fileFormat || '').toUpperCase() }} file.
          </v-alert>

          <v-list v-if="compatiblePrinters.length > 0" class="pa-0">
            <v-list-item
              v-for="printer in compatiblePrinters"
              :key="printer.id"
              @click="togglePrinterSelection(printer.id)"
            >
              <template #prepend>
                <v-checkbox
                  :model-value="selectedPrinters.includes(printer.id)"
                  hide-details
                  density="compact"
                  @click.stop="togglePrinterSelection(printer.id)"
                />
              </template>
              <v-list-item-title>
                {{ printer.name }}
              </v-list-item-title>
              <v-list-item-subtitle>
                {{ getPrinterTypeName(printer.printerType) }}
              </v-list-item-subtitle>

              <template #append>
                <div class="d-flex align-center ga-2">
                  <v-chip
                    v-if="queueCountFor(printer.id) > 0"
                    size="x-small"
                    variant="tonal"
                    color="info"
                    prepend-icon="queue"
                  >
                    {{ queueCountFor(printer.id) }} queued
                  </v-chip>
                  <v-chip
                    size="x-small"
                    variant="tonal"
                    :color="printerLiveStatus(printer.id).color"
                  >
                    {{ printerLiveStatus(printer.id).label }}
                    <template v-if="printerLiveStatus(printer.id).timeLeftSeconds">
                      · {{ formatDuration(printerLiveStatus(printer.id).timeLeftSeconds) }} left
                    </template>
                  </v-chip>
                </div>
              </template>
            </v-list-item>
          </v-list>

          <v-alert
            v-else
            type="warning"
            variant="tonal"
            density="compact"
          >
            No compatible printers for this file format.
          </v-alert>

          <details
            v-if="incompatiblePrinters.length > 0"
            class="mt-3 queue-incompat"
          >
            <summary class="text-caption text-medium-emphasis">
              {{ incompatiblePrinters.length }} printer(s) hidden — incompatible
            </summary>
            <ul class="mt-2">
              <li
                v-for="p in incompatiblePrinters"
                :key="p.id"
                class="text-caption text-medium-emphasis"
              >
                <strong>{{ p.name }}</strong> · {{ p.incompatibilityReason || 'incompatible format' }}
              </li>
            </ul>
          </details>
        </template>
      </v-card-text>

      <v-card-actions>
        <v-spacer />
        <v-btn
          color="grey"
          variant="text"
          @click="$emit('update:modelValue', false)"
        >
          Cancel
        </v-btn>
        <v-btn
          color="primary"
          variant="elevated"
          :disabled="selectedPrinters.length === 0"
          @click="queueToSelectedPrinters"
          :loading="queuing"
        >
          Queue to {{ selectedPrinters.length }} Printer(s)
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts" setup>
import { ref, watch } from 'vue'
import type { FileMetadata } from '@/backend/file-storage.service'
import { PrintQueueService } from '@/backend/print-queue.service'
import { usePrinterStore } from '@/store/printer.store'
import { usePrinterStateStore } from '@/store/printer-state.store'
import { useSnackbar } from '@/shared/snackbar.composable'
import { displayFileName } from '@/utils/file-name.util'
import { formatDuration } from '@/utils/date-time.utils'
import { notifyPrintJobsChanged } from '@/shared/print-jobs-invalidator.composable'
import { getPrinterTypeName } from '@/shared/printer-types.constants'
import { useInvalidateGlobalQueue } from '@/queries/global-queue.query'

interface Props {
  modelValue: boolean
  file: FileMetadata | null
}

interface Emits {
  (e: 'update:modelValue', value: boolean): void
  (e: 'queued'): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const snackbar = useSnackbar()
const printerStore = usePrinterStore()
const printerStateStore = usePrinterStateStore()
const invalidateGlobalQueue = useInvalidateGlobalQueue()

const selectedPrinters = ref<number[]>([])
const queuing = ref(false)
const compatiblePrinters = ref<Array<Record<string, any>>>([])
const incompatiblePrinters = ref<Array<Record<string, any> & { incompatibilityReason?: string }>>([])
const checkingCompat = ref(false)

// Per-printer queue length, fetched once on open. -1 = not loaded yet.
const queueCountByPrinterId = ref<Record<number, number>>({})

// Live status of a printer for the row: whether it's printing/paused/online and
// how much time is left on the current job. Reactive via the printer-state store.
interface PrinterLiveStatus {
  state: 'printing' | 'paused' | 'idle' | 'offline'
  label: string
  color: string
  timeLeftSeconds: number | null
}
function printerLiveStatus(printerId: number): PrinterLiveStatus {
  if (!printerStateStore.isApiResponding(printerId)) {
    return { state: 'offline', label: 'Offline', color: 'grey', timeLeftSeconds: null }
  }
  if (printerStateStore.isPrinterPrinting(printerId)) {
    const raw =
      printerStateStore.printerEventsById[printerId]?.current?.payload?.progress?.printTimeLeft
    return {
      state: 'printing',
      label: 'Printing',
      color: 'success',
      timeLeftSeconds: typeof raw === 'number' && raw > 0 ? raw : null,
    }
  }
  if (printerStateStore.isPrinterPaused(printerId)) {
    return { state: 'paused', label: 'Paused', color: 'warning', timeLeftSeconds: null }
  }
  return { state: 'idle', label: 'Idle', color: 'grey', timeLeftSeconds: null }
}
function queueCountFor(printerId: number): number {
  return queueCountByPrinterId.value[printerId] ?? 0
}

// Reset + check compatibility when dialog opens with a new file
watch(
  () => props.modelValue,
  async (isOpen) => {
    if (!isOpen) return
    selectedPrinters.value = []
    compatiblePrinters.value = []
    incompatiblePrinters.value = []
    queueCountByPrinterId.value = {}
    if (!props.file) return

    checkingCompat.value = true
    try {
      const response = await PrintQueueService.getCompatiblePrinters({
        fileStorageId: props.file.fileStorageId
      })
      // Server returns plain printer objects; filter out disabled ones to
      // keep parity with the previous behaviour.
      compatiblePrinters.value = response.compatible.filter((p) => p.enabled !== false)
      incompatiblePrinters.value = response.incompatible
      loadQueueCounts()
    } catch (err) {
      console.error('Failed to load compatible printers:', err)
      // Fallback to legacy behaviour (all enabled printers) so the dialog
      // remains usable if the endpoint fails.
      compatiblePrinters.value = printerStore.printers.filter((p) => p.enabled)
      incompatiblePrinters.value = []
    } finally {
      checkingCompat.value = false
    }
  }
)

// Fetch queue lengths for the compatible printers in parallel. Best-effort:
// a failed lookup just leaves that printer's count at 0 rather than blocking
// the dialog. Runs after the compatibility list is set.
const loadQueueCounts = async () => {
  const printers = compatiblePrinters.value
  await Promise.all(
    printers.map(async (p) => {
      try {
        const res = await PrintQueueService.getPrinterQueue(p.id)
        queueCountByPrinterId.value = {
          ...queueCountByPrinterId.value,
          [p.id]: res.count,
        }
      } catch (err) {
        console.error(`Failed to load queue for printer ${p.id}:`, err)
      }
    })
  )
}

const togglePrinterSelection = (printerId: number) => {
  const index = selectedPrinters.value.indexOf(printerId)
  if (index > -1) {
    selectedPrinters.value.splice(index, 1)
  } else {
    selectedPrinters.value.push(printerId)
  }
}

const queueToSelectedPrinters = async () => {
  if (!props.file || selectedPrinters.value.length === 0) {
    return
  }

  queuing.value = true
  let successCount = 0
  let failCount = 0

  try {
    for (const printerId of selectedPrinters.value) {
      try {
        await PrintQueueService.createJobFromFile(
          printerId,
          props.file.fileStorageId
        )
        successCount++
      } catch (error) {
        console.error(`Failed to queue to printer ${printerId}:`, error)
        failCount++
      }
    }

    if (successCount > 0) {
      snackbar.info(`Queued file to ${successCount} printer(s)`)
      await invalidateGlobalQueue()
      notifyPrintJobsChanged({ reason: 'queue-dialog:enqueued' })
      emit('queued')
    }
    if (failCount > 0) {
      snackbar.error(`Failed to queue to ${failCount} printer(s)`)
    }

    emit('update:modelValue', false)
  } catch (error) {
    console.error('Failed to queue file:', error)
    snackbar.error('Failed to queue file')
  } finally {
    queuing.value = false
  }
}
</script>
