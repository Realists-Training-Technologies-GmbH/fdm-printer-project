<template>
  <v-container fluid class="dashboard pa-4 pa-md-6">
    <!-- ─── Onboarding banner (only when no printers) ──────────── -->
    <v-alert
      v-if="isNewUser"
      type="info"
      variant="tonal"
      icon="rocket_launch"
      class="mb-6"
    >
      <v-alert-title class="mb-1">Welcome to PrusaHero</v-alert-title>
      <p class="mb-3 text-body-2">
        Set up your first printer to start monitoring your 3D print farm.
      </p>
      <div class="d-flex flex-wrap ga-2">
        <v-btn
          color="primary"
          variant="flat"
          size="small"
          prepend-icon="add"
          @click="goToPrinterGrid"
        >
          Add your first printer
        </v-btn>
        <v-btn
          variant="outlined"
          size="small"
          prepend-icon="help"
          @click="viewDocumentation"
        >
          Documentation
        </v-btn>
      </div>
    </v-alert>

    <!-- ─── Attention banner: printers needing user action ─────── -->
    <v-card
      v-if="printersNeedingAttention.length > 0"
      class="dashboard__attention mb-4"
      elevation="0"
      border
    >
      <div class="dashboard__attention-header">
        <v-icon color="error" class="mr-2">warning_amber</v-icon>
        <strong>
          {{ printersNeedingAttention.length }}
          {{ printersNeedingAttention.length === 1 ? 'printer needs' : 'printers need' }}
          attention
        </strong>
        <v-spacer />
        <v-btn
          variant="tonal"
          size="small"
          prepend-icon="view_module"
          @click="goToPrinterGrid"
        >
          Go to grid
        </v-btn>
      </div>
      <ul class="dashboard__attention-list">
        <li
          v-for="entry in printersNeedingAttention"
          :key="entry.printerId"
          :class="`dashboard__attention-item dashboard__attention-item--${entry.attention.severity}`"
        >
          <v-icon size="small" class="dashboard__attention-icon">
            {{ entry.attention.icon }}
          </v-icon>
          <div class="dashboard__attention-text">
            <div class="font-weight-bold text-truncate">
              {{ entry.printerName }}
            </div>
            <div class="text-caption text-medium-emphasis">
              <strong>{{ entry.attention.title }}</strong>
              <span v-if="entry.attention.message"> · {{ entry.attention.message }}</span>
            </div>
          </div>
        </li>
      </ul>
    </v-card>

    <!-- ─── KPI strip ──────────────────────────────────────────── -->
    <div class="dashboard__kpis">
      <div class="kpi" :class="{ 'kpi--accent-success': printingCount > 0 }">
        <v-icon class="kpi__icon" color="success">print</v-icon>
        <div class="kpi__body">
          <div class="kpi__value">{{ printingCount }}</div>
          <div class="kpi__label">Printing</div>
        </div>
      </div>
      <div class="kpi" :class="{ 'kpi--accent-primary': operationalCount > 0 }">
        <v-icon class="kpi__icon" color="primary">check_circle</v-icon>
        <div class="kpi__body">
          <div class="kpi__value">{{ operationalCount }}</div>
          <div class="kpi__label">Ready</div>
        </div>
      </div>
      <div class="kpi" :class="{ 'kpi--accent-warning': offlineCount > 0 }">
        <v-icon class="kpi__icon" color="warning">warning</v-icon>
        <div class="kpi__body">
          <div class="kpi__value">{{ offlineCount }}</div>
          <div class="kpi__label">Offline / Issue</div>
        </div>
      </div>
      <div class="kpi">
        <v-icon class="kpi__icon" color="medium-emphasis">inventory_2</v-icon>
        <div class="kpi__body">
          <div class="kpi__value">{{ totalPrinters }}</div>
          <div class="kpi__label">Total printers</div>
        </div>
      </div>
    </div>

    <!-- ─── Main split: farm status (2/3) + insights (1/3) ─────── -->
    <v-row>
      <!-- Farm Status -->
      <v-col cols="12" lg="8">
        <v-card class="pa-4 fill-height" elevation="0" border>
          <div class="dashboard__section-header">
            <h3 class="text-subtitle-1 font-weight-bold d-flex align-center ga-2">
              <v-icon size="small">grid_view</v-icon>
              Farm status
            </h3>
          </div>

          <div v-if="totalPrinters > 0" class="dashboard__printer-grid">
            <button
              v-for="printer in filteredPrinters.slice(0, displayLimit)"
              :key="printer.id"
              type="button"
              class="dashboard__printer-tile"
              :class="`dashboard__printer-tile--${getPrinterStatus(printer).toLowerCase()}`"
              @click="openPrinter()"
            >
              <div class="dashboard__printer-tile-header">
                <span class="text-body-2 font-weight-medium text-truncate">
                  {{ printer.name }}
                </span>
                <v-chip
                  :color="getPrinterStatusColor(printer)"
                  size="x-small"
                  variant="flat"
                  class="font-weight-bold flex-shrink-0"
                >
                  {{ getPrinterStatus(printer) }}
                </v-chip>
              </div>
              <div
                v-if="isPrinterPrintingState(printer)"
                class="dashboard__printer-tile-progress"
              >
                <v-progress-linear
                  :model-value="Number(getPrinterProgress(printer))"
                  color="success"
                  height="4"
                  rounded
                />
                <span class="text-caption text-medium-emphasis">
                  {{ getPrinterProgress(printer) }}%
                </span>
              </div>
            </button>
          </div>

          <div
            v-if="totalPrinters > displayLimit"
            class="text-center mt-4"
          >
            <v-btn
              variant="text"
              color="primary"
              size="small"
              append-icon="arrow_forward"
              @click="goToPrinterGrid"
            >
              View all {{ totalPrinters }} printers
            </v-btn>
          </div>

          <div v-if="totalPrinters === 0" class="text-center py-10">
            <v-icon size="56" color="medium-emphasis" class="mb-3">add_circle_outline</v-icon>
            <div class="text-body-1 font-weight-medium mb-1">No printers yet</div>
            <div class="text-body-2 text-medium-emphasis mb-4">
              Add your first 3D printer to start monitoring.
            </div>
            <v-btn
              color="primary"
              variant="flat"
              prepend-icon="add"
              @click="goToPrinterGrid"
            >
              Add printer
            </v-btn>
          </div>
        </v-card>
      </v-col>

      <!-- Performance insights -->
      <v-col cols="12" lg="4">
        <v-card class="pa-4 fill-height" elevation="0" border>
          <h3 class="text-subtitle-1 font-weight-bold d-flex align-center ga-2 mb-4">
            <v-icon size="small">trending_up</v-icon>
            Performance
          </h3>

          <div class="dashboard__metric">
            <div class="dashboard__metric-head">
              <span class="text-body-2 text-medium-emphasis">Farm utilization</span>
              <span class="font-weight-bold">{{ farmUtilization }}%</span>
            </div>
            <v-progress-linear
              :model-value="farmUtilization"
              color="primary"
              height="6"
              rounded
            />
          </div>

          <div class="dashboard__metric">
            <div class="dashboard__metric-head">
              <span class="text-body-2 text-medium-emphasis">Success rate (last 7d)</span>
              <span class="font-weight-bold text-success">{{ successRate }}%</span>
            </div>
            <v-progress-linear
              :model-value="successRate"
              color="success"
              height="6"
              rounded
            />
            <Sparkline
              v-if="dailySuccessSeries.length > 1"
              :values="dailySuccessSeries"
              :width="280"
              :height="32"
              color="rgb(var(--v-theme-success))"
              class="mt-2 dashboard__sparkline"
              aria-label="Daily success rate"
            />
          </div>

          <div class="dashboard__metric">
            <div class="dashboard__metric-head">
              <span class="text-body-2 text-medium-emphasis">Prints / day (last 14d)</span>
              <span class="font-weight-bold">{{ totalPrintsLast14d }}</span>
            </div>
            <DayBars
              v-if="dayBuckets.length"
              :buckets="dayBuckets"
              class="mt-1"
            />
          </div>

          <v-divider class="my-4" />

          <div class="dashboard__stat-list">
            <div class="dashboard__stat-row">
              <span class="text-body-2 text-medium-emphasis">Active jobs</span>
              <strong>{{ activeJobs }}</strong>
            </div>
            <div class="dashboard__stat-row">
              <span class="text-body-2 text-medium-emphasis">Queue length</span>
              <strong>{{ queueLength }}</strong>
            </div>
            <div class="dashboard__stat-row">
              <span class="text-body-2 text-medium-emphasis">Avg. print time</span>
              <strong>{{ avgPrintTime }}</strong>
            </div>
          </div>

          <v-btn
            color="primary"
            variant="tonal"
            block
            class="mt-5"
            prepend-icon="analytics"
            @click="gotoJobs"
          >
            View job analytics
          </v-btn>
        </v-card>
      </v-col>
    </v-row>

    <!-- ─── Top files / top printers (last 7d) ─────────────────── -->
    <v-row v-if="topFiles.length > 0 || topPrinters.length > 0" class="mt-1">
      <v-col cols="12" md="6">
        <v-card class="pa-4 fill-height" elevation="0" border>
          <h3 class="text-subtitle-1 font-weight-bold d-flex align-center ga-2 mb-3">
            <v-icon size="small">insert_drive_file</v-icon>
            Top files
            <span class="text-caption text-medium-emphasis ml-auto">last 7d</span>
          </h3>
          <ol v-if="topFiles.length > 0" class="dashboard__top-list">
            <li v-for="(t, i) in topFiles" :key="t.key">
              <span class="dashboard__top-rank">{{ i + 1 }}</span>
              <span
                class="dashboard__top-name text-truncate"
                :title="displayFileName(t.sample)"
              >
                {{ displayFileName(t.sample) }}
              </span>
              <span class="dashboard__top-count">{{ t.count }}×</span>
            </li>
          </ol>
          <div v-else class="text-body-2 text-medium-emphasis text-center py-4">
            No print jobs in the last 7 days.
          </div>
        </v-card>
      </v-col>
      <v-col cols="12" md="6">
        <v-card class="pa-4 fill-height" elevation="0" border>
          <h3 class="text-subtitle-1 font-weight-bold d-flex align-center ga-2 mb-3">
            <v-icon size="small">print</v-icon>
            Top printers
            <span class="text-caption text-medium-emphasis ml-auto">last 7d</span>
          </h3>
          <ol v-if="topPrinters.length > 0" class="dashboard__top-list">
            <li v-for="(t, i) in topPrinters" :key="t.key">
              <span class="dashboard__top-rank">{{ i + 1 }}</span>
              <span class="dashboard__top-name text-truncate">
                {{ printerNameFromId(Number(t.key)) }}
              </span>
              <span class="dashboard__top-count">{{ t.count }}×</span>
            </li>
          </ol>
          <div v-else class="text-body-2 text-medium-emphasis text-center py-4">
            No print jobs in the last 7 days.
          </div>
        </v-card>
      </v-col>
    </v-row>

    <!-- ─── Quick actions ──────────────────────────────────────── -->
    <v-card class="pa-4 mt-4" elevation="0" border>
      <h3 class="text-subtitle-1 font-weight-bold d-flex align-center ga-2 mb-3">
        <v-icon size="small">bolt</v-icon>
        Quick actions
      </h3>
      <div class="d-flex flex-wrap ga-2">
        <v-btn
          variant="tonal"
          color="primary"
          prepend-icon="view_module"
          @click="goToPrinterGrid"
        >
          Printer grid
        </v-btn>
        <v-btn
          variant="tonal"
          color="primary"
          prepend-icon="list"
          @click="goToPrinterList"
        >
          Printer list
        </v-btn>
        <v-btn
          variant="tonal"
          color="primary"
          prepend-icon="camera_alt"
          @click="goToCameras"
        >
          Cameras
        </v-btn>
        <v-btn
          variant="tonal"
          color="primary"
          prepend-icon="history"
          @click="gotoJobs"
        >
          Print jobs
        </v-btn>
        <v-divider vertical class="mx-2 my-1" />
        <v-btn
          variant="tonal"
          prepend-icon="code"
          @click="openYamlDialog"
        >
          Import / export YAML
        </v-btn>
        <v-btn
          variant="tonal"
          prepend-icon="publish"
          @click="openOctoFarmImportDialog"
        >
          Import OctoFarm
        </v-btn>
      </div>
    </v-card>
  </v-container>
</template>

<script lang="ts" setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { usePrinterStore } from '@/store/printer.store'
import { usePrinterStateStore } from '@/store/printer-state.store'
import {
  isPrinterPrinting,
  isPrinterDisconnected,
  isPrinterInMaintenance,
  isPrinterDisabled
} from '@/shared/printer-state.constants'
import { usePrinterFilters } from '@/shared/printer-filter.composable'
import Sparkline from '@/components/Generic/Sparkline.vue'
import DayBars from '@/components/Generic/DayBars.vue'
import { useDialog } from '@/shared/dialog.composable'
import { DialogName } from '@/components/Generic/Dialogs/dialog.constants'
import { PrintJobService, type PrintJobDto } from '@/backend/print-job.service'
import {
  calculateJobPerformanceMetrics,
  formatPrintTime,
  bucketJobsByDay,
  dailySuccessRate,
  topByCount
} from '@/shared/dashboard-statistics'
import { displayFileName } from '@/utils/file-name.util'
import { derivePrinterAttention } from '@/shared/printer-attention.util'
import { useGlobalQueueQuery } from '@/queries/global-queue.query'

const router = useRouter()
const printerStore = usePrinterStore()
const printerStateStore = usePrinterStateStore()

const recentJobs = ref<PrintJobDto[]>([])
const displayLimit = 12

const { data: queueData } = useGlobalQueueQuery()

const { loadTags, filterPrinters } = usePrinterFilters()

onMounted(async () => {
  await loadTags()
  await loadRecentJobs()
})

async function loadRecentJobs() {
  try {
    const sevenDaysAgo = new Date()
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
    const response = await PrintJobService.searchJobsPaged({
      startDate: sevenDaysAgo.toISOString().split('T')[0],
      page: 1,
      pageSize: 500
    })
    recentJobs.value = response.items
  } catch (error) {
    console.error('Failed to load recent jobs:', error)
    recentJobs.value = []
  }
}

const printers = computed(() => printerStore.printers)
const filteredPrinters = computed(() => filterPrinters(printers.value))
const totalPrinters = computed(() => printers.value.length)
const printingCount = computed(() => printerStateStore.printingCount)
const operationalCount = computed(() => printerStateStore.operationalNotPrintingCount)
const offlineCount = computed(() =>
  printers.value.filter(p => {
    const state = printerStateStore.printerEventsById[p.id]
    return isPrinterDisconnected(p, state) || isPrinterInMaintenance(p)
  }).length
)

const isNewUser = computed(() => totalPrinters.value === 0)

const farmUtilization = computed(() => {
  if (totalPrinters.value === 0) return 0
  return Math.round((printingCount.value / totalPrinters.value) * 100)
})

const jobMetrics = computed(() => calculateJobPerformanceMetrics(recentJobs.value, 24))
const successRate = computed(() => jobMetrics.value.successRate)
const activeJobs = computed(() => jobMetrics.value.activeJobs)
const queueLength = computed(() => queueData.value?.totalJobs || 0)
const avgPrintTime = computed(() => formatPrintTime(jobMetrics.value.averagePrintTimeHours))

// Time-series for sparklines and the daily bar chart.
const dayBuckets = computed(() => bucketJobsByDay(recentJobs.value, 14))
const dailySuccessSeries = computed(() => dailySuccessRate(recentJobs.value, 14))
const totalPrintsLast14d = computed(() =>
  dayBuckets.value.reduce((acc, b) => acc + b.total, 0)
)

// Top files / top printers from the last 7 days (recentJobs window).
const topFiles = computed(() =>
  topByCount(
    recentJobs.value,
    (j) => (j.fileStorageId ?? j.fileName ?? null) as string | null,
    5
  )
)

const topPrinters = computed(() =>
  topByCount(
    recentJobs.value,
    (j) => j.printerId,
    5
  )
)

function printerNameFromId(id: number | null | undefined): string {
  if (id == null) return 'Unknown printer'
  return printerStore.printer(id)?.name ?? `Printer #${id}`
}

// ── Printers needing user action (ATTENTION, error, etc.) ─────
const printersNeedingAttention = computed(() => {
  const sevRank: Record<string, number> = { critical: 0, warning: 1, info: 2 }
  return printers.value
    .map((p) => ({
      printerId: p.id,
      printerName: p.name,
      attention: derivePrinterAttention(
        p,
        printerStateStore.printerEventsById[p.id],
        printerStateStore.socketStatesById[p.id],
      ),
    }))
    .filter((e) => e.attention.needsAttention && e.attention.severity !== 'info')
    .sort((a, b) =>
      sevRank[a.attention.severity] - sevRank[b.attention.severity]
    )
})

const goToPrinterGrid = () => router.push('/printer-grid')
const goToPrinterList = () => router.push('/printer-list')
const goToCameras = () => router.push('/cameras')
const gotoJobs = () => router.push('/jobs')

const viewDocumentation = () => {
  globalThis.open('https://github.com/jechandia/prusahero', '_blank')
}

const openYamlDialog = () => useDialog(DialogName.YamlImportExport).openDialog()
const openOctoFarmImportDialog = () => useDialog(DialogName.ImportOctoFarmDialog).openDialog()

const openPrinter = () => router.push('/printer-grid')

const isPrinterPrintingState = (printer: any) => {
  const state = printerStateStore.printerEventsById[printer.id]
  return isPrinterPrinting(state)
}

const getPrinterStatus = (printer: any) => {
  const state = printerStateStore.printerEventsById[printer.id]
  if (isPrinterInMaintenance(printer)) return 'MAINTENANCE'
  if (isPrinterDisabled(printer)) return 'DISABLED'
  if (isPrinterDisconnected(printer, state)) return 'OFFLINE'
  if (isPrinterPrinting(state)) return 'PRINTING'
  return 'READY'
}

const getPrinterStatusColor = (printer: any) => {
  switch (getPrinterStatus(printer)) {
    case 'PRINTING': return 'success'
    case 'READY': return 'primary'
    case 'MAINTENANCE': return 'warning'
    case 'OFFLINE': return 'error'
    case 'DISABLED': return 'grey'
    default: return undefined
  }
}

const getPrinterProgress = (printer: any) => {
  const state = printerStateStore.printerEventsById[printer.id]
  return state?.current?.payload?.progress?.completion?.toFixed(1) || 0
}
</script>

<style scoped>
/* ─── Attention banner ───────────────────────────────────────── */
.dashboard__attention {
  border-color: rgba(var(--v-theme-error), 0.4) !important;
  background: rgba(var(--v-theme-error), 0.05);
}

.dashboard__attention-header {
  display: flex;
  align-items: center;
  padding: 12px 16px 8px;
  font-size: 14px;
}

.dashboard__attention-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}

.dashboard__attention-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  min-width: 0;
}

.dashboard__attention-item:last-child {
  border-bottom: none;
}

.dashboard__attention-item--critical .dashboard__attention-icon {
  color: rgb(var(--v-theme-error));
}

.dashboard__attention-item--warning .dashboard__attention-icon {
  color: rgb(var(--v-theme-warning));
}

.dashboard__attention-text {
  flex: 1 1 auto;
  min-width: 0;
}

/* ─── KPI strip ──────────────────────────────────────────────── */
.dashboard__kpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  margin-bottom: 24px;
}

.kpi {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 10px;
  background: rgb(var(--v-theme-surface));
  position: relative;
  overflow: hidden;
}

.kpi::before {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  background: transparent;
  transition: background 0.15s ease;
}

.kpi--accent-success::before {
  background: rgb(var(--v-theme-success));
}

.kpi--accent-primary::before {
  background: rgb(var(--v-theme-primary));
}

.kpi--accent-warning::before {
  background: rgb(var(--v-theme-warning));
}

.kpi__icon {
  font-size: 28px !important;
  flex-shrink: 0;
}

.kpi__body {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.kpi__value {
  font-size: 1.75rem;
  font-weight: 700;
  line-height: 1;
}

.kpi__label {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: rgba(var(--v-theme-on-surface), 0.65);
  margin-top: 2px;
}

/* ─── Section headers ────────────────────────────────────────── */
.dashboard__section-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

/* ─── Printer mini-grid ──────────────────────────────────────── */
.dashboard__printer-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 10px;
}

.dashboard__printer-tile {
  all: unset;
  cursor: pointer;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgb(var(--v-theme-surface));
  transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease;
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow: hidden;
}

.dashboard__printer-tile::before {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
}

.dashboard__printer-tile--printing::before { background: rgb(var(--v-theme-success)); }
.dashboard__printer-tile--ready::before    { background: rgb(var(--v-theme-primary)); }
.dashboard__printer-tile--maintenance::before { background: rgb(var(--v-theme-warning)); }
.dashboard__printer-tile--offline::before  { background: rgb(var(--v-theme-error)); }
.dashboard__printer-tile--disabled::before { background: rgba(var(--v-theme-on-surface), 0.3); }

.dashboard__printer-tile:hover {
  transform: translateY(-1px);
  border-color: rgba(var(--v-theme-on-surface), 0.32);
}

.dashboard__printer-tile-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.dashboard__printer-tile-progress {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dashboard__printer-tile-progress :deep(.v-progress-linear) {
  flex: 1 1 auto;
}

/* ─── Metric rows ────────────────────────────────────────────── */
.dashboard__metric {
  margin-bottom: 16px;
}

.dashboard__metric-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.dashboard__stat-list {
  display: flex;
  flex-direction: column;
}

.dashboard__stat-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}

.dashboard__stat-row:last-child {
  border-bottom: none;
}

/* ─── Top files / printers ──────────────────────────────────── */
.dashboard__top-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.dashboard__top-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  min-width: 0;
}

.dashboard__top-list li:last-child {
  border-bottom: none;
}

.dashboard__top-rank {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: rgba(var(--v-theme-primary), 0.12);
  color: rgb(var(--v-theme-primary));
  font-size: 11px;
  font-weight: 700;
  flex-shrink: 0;
}

.dashboard__top-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
}

.dashboard__top-count {
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 700;
  color: rgba(var(--v-theme-on-surface), 0.65);
}

.dashboard__sparkline {
  opacity: 0.9;
}
</style>
