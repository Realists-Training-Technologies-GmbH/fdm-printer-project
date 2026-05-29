<template>
  <v-dialog v-model="visible" max-width="880" scrollable>
    <v-card>
      <v-card-title class="d-flex align-center justify-space-between">
        <div class="d-flex align-center" style="min-width: 0;">
          <v-icon class="mr-2" color="primary">analytics</v-icon>
          <span class="text-truncate">{{ printer?.name ?? '—' }}</span>
        </div>
        <v-btn icon="close" variant="text" size="small" @click="visible = false" />
      </v-card-title>

      <v-divider />

      <v-card-text class="pa-4">
        <!-- Summary cards. Always-visible; the figures are derived from
             whatever jobs are in scope (loaded via the search query), so
             they reflect the same window the table below shows. -->
        <v-row dense class="pdd-stats">
          <v-col v-for="stat in stats" :key="stat.label" cols="6" sm="3">
            <v-card variant="tonal" :color="stat.color">
              <v-card-text class="py-3">
                <div class="text-caption text-medium-emphasis">{{ stat.label }}</div>
                <div class="text-h6 mt-1">{{ stat.value }}</div>
                <div
                  v-if="stat.sub"
                  class="text-caption text-medium-emphasis mt-1"
                >
                  {{ stat.sub }}
                </div>
              </v-card-text>
            </v-card>
          </v-col>
        </v-row>

        <!-- Estimated vs actual chart. Tiny SVG sparkline-style — avoids
             pulling in a charting library for one panel. Each pair plots
             estimated (faded) and actual (bold) bars side-by-side, capped
             at the longest job in the window so the visual stays
             readable even when one print dwarfs the others. -->
        <div v-if="durationChartData.length > 0" class="mt-5">
          <div class="text-overline text-medium-emphasis mb-1">
            Estimated vs actual duration (last {{ durationChartData.length }} completed prints)
          </div>
          <svg
            :viewBox="`0 0 ${chartWidth} ${chartHeight}`"
            class="pdd-chart"
            preserveAspectRatio="none"
            role="img"
            :aria-label="`Bar chart: estimated vs actual duration for the last ${durationChartData.length} prints`"
          >
            <g
              v-for="(d, idx) in durationChartData"
              :key="d.jobId"
              :transform="`translate(${idx * (barGroupWidth + barGap)}, 0)`"
            >
              <rect
                :x="0"
                :y="chartHeight - estimatedHeight(d)"
                :width="barWidth"
                :height="estimatedHeight(d)"
                rx="1"
                fill="rgba(120, 160, 200, 0.45)"
              >
                <title>Estimated: {{ formatDuration(d.estimatedSeconds) }}</title>
              </rect>
              <rect
                :x="barWidth + 1"
                :y="chartHeight - actualHeight(d)"
                :width="barWidth"
                :height="actualHeight(d)"
                rx="1"
                :fill="d.actualSeconds > d.estimatedSeconds ? '#e07a5f' : '#7ac74f'"
              >
                <title>Actual: {{ formatDuration(d.actualSeconds) }}</title>
              </rect>
            </g>
          </svg>
        </div>

        <!-- History table -->
        <div class="mt-5">
          <div class="d-flex align-center mb-2">
            <div class="text-overline text-medium-emphasis">Recent jobs</div>
            <v-spacer />
            <v-progress-circular
              v-if="isLoading"
              indeterminate
              size="16"
              width="2"
              class="mr-2"
            />
          </div>
          <v-data-table
            :headers="historyHeaders"
            :items="historyItems"
            :loading="isLoading"
            density="comfortable"
            hover
            class="pdd-table"
          >
            <template #item.status="{ item }">
              <v-chip
                :color="statusColor(item.status)"
                size="x-small"
                variant="tonal"
                density="comfortable"
              >
                {{ statusLabel(item.status) }}
              </v-chip>
            </template>
            <template #item.startedAt="{ item }">
              {{ formatDateOrDash(item.startedAt) }}
            </template>
            <template #item.duration="{ item }">
              {{ formatDuration(item.durationSeconds) }}
            </template>
            <template #item.estimated="{ item }">
              {{ formatDuration(item.estimatedSeconds) }}
            </template>
            <template #item.delta="{ item }">
              <span
                v-if="item.deltaSeconds !== null"
                :class="item.deltaSeconds >= 0 ? 'text-error' : 'text-success'"
              >
                {{ item.deltaSeconds >= 0 ? '+' : '' }}{{ formatDuration(Math.abs(item.deltaSeconds)) }}
              </span>
              <span v-else class="text-medium-emphasis">—</span>
            </template>
          </v-data-table>
        </div>
      </v-card-text>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { PrintJobService, PrintJobDto } from '@/backend/print-job.service'
import { usePrinterStore } from '@/store/printer.store'

const visible = defineModel<boolean>({ required: true })

const props = defineProps<{
  printerId: number | undefined
}>()

const printerStore = usePrinterStore()
const printer = computed(() =>
  props.printerId ? printerStore.printer(props.printerId) : undefined,
)

// Load the last 50 jobs for this printer whenever the dialog opens.
// Using `enabled` keyed to `visible` so we don't hit the API just for
// having the component mounted on tiles the user never clicked.
const { data: pagedResponse, isLoading } = useQuery({
  queryKey: ['printer-detail', () => props.printerId, () => visible.value],
  queryFn: async () => {
    if (!props.printerId || !visible.value) return null
    return PrintJobService.searchJobsPaged({
      searchPrinter: String(props.printerId),
      page: 1,
      pageSize: 50,
    })
  },
  enabled: computed(() => visible.value && !!props.printerId),
})

const jobs = computed<PrintJobDto[]>(() => pagedResponse.value?.items ?? [])

// Stats from the loaded window. Counts are straightforward; total
// filament and total runtime sum across COMPLETED jobs only (in-flight
// or failed prints would skew the averages).
const stats = computed(() => {
  const completed = jobs.value.filter((j) => j.status === 'COMPLETED')
  const failed = jobs.value.filter((j) => j.status === 'FAILED')
  const cancelled = jobs.value.filter((j) => j.status === 'CANCELLED')
  const totalFilament = completed.reduce(
    (sum, j) => sum + filamentTotal(j.metadata?.filamentUsedGrams),
    0,
  )
  const totalSeconds = completed.reduce(
    (sum, j) => sum + (j.statistics?.actualPrintTimeSeconds ?? 0),
    0,
  )

  return [
    {
      label: 'Completed',
      value: String(completed.length),
      sub: `${jobs.value.length} jobs scanned`,
      color: 'success',
    },
    {
      label: 'Failed',
      value: String(failed.length),
      sub: `+ ${cancelled.length} cancelled`,
      color: failed.length > 0 ? 'error' : 'default',
    },
    {
      label: 'Filament',
      value: totalFilament > 0 ? `${(totalFilament / 1000).toFixed(2)} kg` : '0 g',
      sub: 'across completed prints',
      color: 'primary',
    },
    {
      label: 'Print time',
      value: formatDurationCompact(totalSeconds),
      sub: 'cumulative',
      color: 'primary',
    },
  ]
})

interface HistoryRow {
  jobId: number
  status: string
  fileName: string
  startedAt: Date | string | null
  durationSeconds: number | null
  estimatedSeconds: number | null
  deltaSeconds: number | null
}

const historyHeaders = [
  { title: 'Status', key: 'status' },
  { title: 'File', key: 'fileName' },
  { title: 'Started', key: 'startedAt' },
  { title: 'Duration', key: 'duration' },
  { title: 'Estimated', key: 'estimated' },
  { title: 'Δ', key: 'delta' },
]

const historyItems = computed<HistoryRow[]>(() =>
  jobs.value.map((j) => {
    const duration = j.statistics?.actualPrintTimeSeconds ?? null
    const estimated = j.metadata?.gcodePrintTimeSeconds ?? null
    return {
      jobId: j.id,
      status: j.status,
      fileName: j.fileName,
      startedAt: j.startedAt,
      durationSeconds: duration,
      estimatedSeconds: estimated,
      deltaSeconds:
        duration !== null && estimated !== null ? duration - estimated : null,
    }
  }),
)

// Duration-comparison chart data — only COMPLETED jobs that carry both
// numbers. Limited to 12 so the bar groups stay readable in a dialog
// that's narrower than the full print-jobs page.
interface ChartPoint {
  jobId: number
  estimatedSeconds: number
  actualSeconds: number
}

const durationChartData = computed<ChartPoint[]>(() => {
  const out: ChartPoint[] = []
  for (const j of jobs.value) {
    if (j.status !== 'COMPLETED') continue
    const est = j.metadata?.gcodePrintTimeSeconds ?? null
    const act = j.statistics?.actualPrintTimeSeconds ?? null
    if (est && act) {
      out.push({ jobId: j.id, estimatedSeconds: est, actualSeconds: act })
    }
    if (out.length >= 12) break
  }
  return out.reverse()
})

const chartWidth = 720
const chartHeight = 100
const barGap = 6
const barGroupWidth = computed(() => {
  const groups = Math.max(1, durationChartData.value.length)
  return Math.max(8, (chartWidth - barGap * (groups - 1)) / groups - 1)
})
const barWidth = computed(() => Math.max(3, barGroupWidth.value / 2 - 1))

const chartMaxSeconds = computed(() => {
  let max = 0
  for (const d of durationChartData.value) {
    if (d.estimatedSeconds > max) max = d.estimatedSeconds
    if (d.actualSeconds > max) max = d.actualSeconds
  }
  return max
})

function estimatedHeight(d: ChartPoint): number {
  const max = chartMaxSeconds.value
  if (!max) return 0
  return Math.round((d.estimatedSeconds / max) * (chartHeight - 4))
}
function actualHeight(d: ChartPoint): number {
  const max = chartMaxSeconds.value
  if (!max) return 0
  return Math.round((d.actualSeconds / max) * (chartHeight - 4))
}

// Formatters — kept inline rather than pulled from date-time.utils so the
// dialog stays self-contained and the formats can drift without affecting
// the global helpers (e.g. the compact ones use no seconds component).
function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return '—'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${Math.floor(seconds)}s`
}
function formatDurationCompact(seconds: number): string {
  if (!seconds || seconds <= 0) return '0m'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}
function formatDateOrDash(value: Date | string | null | undefined): string {
  if (!value) return '—'
  const d = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function statusColor(status: string): string {
  switch (status) {
    case 'COMPLETED': return 'success'
    case 'FAILED': return 'error'
    case 'CANCELLED': return 'warning'
    case 'PRINTING': case 'STARTING': return 'primary'
    case 'PAUSED': return 'orange'
    default: return 'default'
  }
}
function statusLabel(status: string): string {
  const map: Record<string, string> = {
    PENDING: 'Pending',
    QUEUED: 'Queued',
    STARTING: 'Transferring',
    PRINTING: 'Printing',
    PAUSED: 'Paused',
    COMPLETED: 'Completed',
    FAILED: 'Failed',
    CANCELLED: 'Cancelled',
    UNKNOWN: 'Unknown',
  }
  return map[status] ?? status
}

// Single-extruder prints arrive as a number, MMU prints as an array.
function filamentTotal(v: number | number[] | null | undefined): number {
  if (v == null) return 0
  if (Array.isArray(v)) return v.reduce((a, b) => a + (b || 0), 0)
  return v
}

// Sneaky no-op so unused-import lint doesn't flag the watch import — kept
// in case we want to react to printerId changes later (clear stale data).
watch(
  () => props.printerId,
  () => {
    /* placeholder for printerId-change reactions */
  },
)
</script>

<style scoped>
.pdd-stats {
  margin-left: -4px;
  margin-right: -4px;
}

.pdd-chart {
  width: 100%;
  height: 100px;
  display: block;
  background: rgba(255, 255, 255, 0.02);
  border-radius: 4px;
  padding: 2px 4px;
}

.pdd-table :deep(.v-data-table-footer) {
  /* The footer's row-per-page selector is overkill in a dialog; the table
     is already paged client-side via the 50-row query. */
  display: none;
}
</style>
