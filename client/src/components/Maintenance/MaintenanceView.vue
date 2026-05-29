<template>
  <div class="maint-view">
    <!-- Header summary chips. Always-visible counters so the user knows
         at a glance how much is outstanding across the whole farm. -->
    <div class="maint-summary">
      <span class="text-h6">Maintenance</span>

      <v-chip
        v-if="counts.active > 0"
        size="small"
        color="warning"
        variant="tonal"
        density="comfortable"
        class="ml-3"
      >
        <v-icon size="14" start>priority_high</v-icon>
        {{ counts.active }} active
      </v-chip>
      <v-chip
        size="small"
        color="success"
        variant="tonal"
        density="comfortable"
        class="ml-2"
      >
        <v-icon size="14" start>check_circle</v-icon>
        {{ counts.resolved }} resolved
      </v-chip>

      <v-spacer />

      <!-- Filter row -->
      <v-btn-toggle
        v-model="filterMode"
        density="comfortable"
        color="primary"
        mandatory
        variant="outlined"
        class="mr-3"
      >
        <v-btn size="small" value="all">All</v-btn>
        <v-btn size="small" value="active">Active</v-btn>
        <v-btn size="small" value="resolved">Resolved</v-btn>
      </v-btn-toggle>

      <v-select
        v-model="printerFilter"
        :items="printerFilterOptions"
        item-title="title"
        item-value="value"
        label="Printer"
        density="compact"
        hide-details
        clearable
        style="max-width: 220px;"
      />
    </div>

    <v-divider class="my-3" />

    <!-- Body -->
    <div v-if="isLoading" class="maint-loading">
      <v-progress-circular indeterminate size="32" width="3" />
      <span class="text-body-2 text-medium-emphasis ml-3">Loading maintenance entries…</span>
    </div>

    <div v-else-if="visibleLogs.length === 0" class="maint-empty">
      <v-icon size="56" color="medium-emphasis">build</v-icon>
      <p class="text-body-1 mt-2">No maintenance entries{{ printerFilter ? ' for this printer' : '' }}.</p>
      <p class="text-caption text-medium-emphasis">
        Log entries from any printer tile, or from this page using the button below.
      </p>
      <v-btn
        v-if="printerFilter"
        class="mt-4"
        color="primary"
        variant="tonal"
        prepend-icon="build"
        @click="openCreate(printerFilter)"
      >
        Log maintenance
      </v-btn>
    </div>

    <div v-else class="maint-list">
      <div
        v-for="log in visibleLogs"
        :key="log.id"
        class="maint-row"
        :class="{ 'maint-row--active': !log.completed }"
      >
        <div class="maint-row__header">
          <v-chip
            size="x-small"
            variant="tonal"
            :color="log.completed ? 'success' : 'warning'"
            density="comfortable"
          >
            {{ log.completed ? 'Resolved' : 'Active' }}
          </v-chip>
          <span class="maint-row__printer ml-2">
            {{ log.printerName || 'Unknown printer' }}
          </span>
          <span class="maint-row__cause text-body-2 ml-2">
            · {{ log.metadata?.cause || 'Unspecified cause' }}
          </span>
          <v-spacer />
          <span class="text-caption text-medium-emphasis">
            {{ formatDateOrDash(log.createdAt) }} · {{ log.createdBy || 'unknown' }}
          </span>
          <v-btn
            v-if="!log.completed"
            size="x-small"
            variant="text"
            color="success"
            class="ml-2"
            :loading="completingLogId === log.id"
            @click="completeLog(log.id)"
          >
            Mark complete
          </v-btn>
          <v-btn
            size="x-small"
            variant="text"
            color="error"
            class="ml-1"
            :loading="deletingLogId === log.id"
            @click="deleteLog(log.id)"
          >
            <v-icon size="14">delete_outline</v-icon>
          </v-btn>
        </div>

        <div
          v-if="log.metadata?.notes"
          class="maint-row__notes text-body-2 text-medium-emphasis mt-2"
        >
          {{ log.metadata.notes }}
        </div>

        <div
          v-if="log.metadata?.partsInvolved?.length"
          class="maint-row__parts mt-2"
        >
          <v-chip
            v-for="part in log.metadata.partsInvolved"
            :key="part"
            size="x-small"
            variant="outlined"
            density="comfortable"
            class="mr-1"
          >
            {{ part }}
          </v-chip>
        </div>

        <div
          v-if="log.completed && log.metadata?.completionNotes"
          class="maint-row__completion text-caption mt-2"
        >
          ↳ {{ log.metadata.completionNotes }}
          <span class="text-medium-emphasis">
            · {{ formatDateOrDash(log.completedAt) }} · {{ log.completedBy || 'unknown' }}
          </span>
        </div>
      </div>
    </div>

    <!-- Floating "Log maintenance" — opens the existing create dialog
         scoped to the currently-filtered printer (or prompts to pick
         one when no filter is active). -->
    <v-btn
      v-if="!isLoading"
      class="maint-fab"
      color="primary"
      icon="add"
      size="large"
      :title="printerFilter ? 'Log maintenance for the filtered printer' : 'Pick a printer first to log maintenance'"
      :disabled="!printerFilter"
      @click="openCreate(printerFilter ?? undefined)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { PrinterMaintenanceLogService } from '@/backend/printer-maintenance-log.service'
import type { PrinterMaintenanceLog } from '@/models/printers/printer-maintenance-log.model'
import { usePrinterStore } from '@/store/printer.store'
import { useSnackbar } from '@/shared/snackbar.composable'
import { useDialog } from '@/shared/dialog.composable'
import { DialogName } from '@/components/Generic/Dialogs/dialog.constants'

const printerStore = usePrinterStore()
const snackbar = useSnackbar()
const createDialog = useDialog(DialogName.PrinterMaintenanceDialog)

const logs = ref<PrinterMaintenanceLog[]>([])
const isLoading = ref(false)
const completingLogId = ref<number | null>(null)
const deletingLogId = ref<number | null>(null)

// Filter state. Persisted in URL via plain ref + replaceState so a
// shared link to /maintenance?printer=4&filter=active lands on the
// right view; cheap enough to do without vue-router on-the-fly nav.
const filterMode = ref<'all' | 'active' | 'resolved'>('all')
const printerFilter = ref<number | null>(null)

const printerFilterOptions = computed(() => [
  ...printerStore.printers.map((p) => ({ title: p.name, value: p.id })),
])

const visibleLogs = computed(() => {
  let out = logs.value
  if (printerFilter.value) out = out.filter((l) => l.printerId === printerFilter.value)
  if (filterMode.value === 'active') out = out.filter((l) => !l.completed)
  else if (filterMode.value === 'resolved') out = out.filter((l) => l.completed)
  // Active rows bubble to the top regardless of overall sort so the user
  // sees what's outstanding first.
  return [...out].sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  })
})

const counts = computed(() => {
  const active = logs.value.filter((l) => !l.completed).length
  return { active, resolved: logs.value.length - active, total: logs.value.length }
})

async function load() {
  isLoading.value = true
  try {
    // Paged endpoint — pageSize 100 covers a single workshop's history
    // without needing a UI pager. (Server caps at 500; staying well
    // under that leaves room for a future tightening.) If a farm
    // outgrows it, split into infinite-scroll later — not worth the
    // complexity today.
    const response = await PrinterMaintenanceLogService.listLogs({
      page: 1,
      pageSize: 100,
    })
    logs.value = response.logs ?? []
  } catch (e: any) {
    snackbar.openErrorMessage({
      title: 'Could not load maintenance entries',
      subtitle: e?.message ?? 'Unknown error',
    })
  } finally {
    isLoading.value = false
  }
}

async function openCreate(printerId?: number) {
  if (!printerId) return
  await createDialog.openDialog({ printerId })
  await load()
}

async function completeLog(id: number) {
  completingLogId.value = id
  try {
    await PrinterMaintenanceLogService.complete(id, {})
    snackbar.openInfoMessage({ title: 'Maintenance marked complete' })
    await load()
  } catch (e: any) {
    snackbar.openErrorMessage({
      title: 'Could not mark complete',
      subtitle: e?.message ?? 'Unknown error',
    })
  } finally {
    completingLogId.value = null
  }
}

async function deleteLog(id: number) {
  // Confirm inline since this is a destructive action and the entry
  // carries operator-written context (notes, parts).
  if (!confirm('Delete this maintenance entry? This cannot be undone.')) return
  deletingLogId.value = id
  try {
    await PrinterMaintenanceLogService.deleteLog(id)
    snackbar.openInfoMessage({ title: 'Maintenance entry deleted' })
    await load()
  } catch (e: any) {
    snackbar.openErrorMessage({
      title: 'Could not delete entry',
      subtitle: e?.message ?? 'Unknown error',
    })
  } finally {
    deletingLogId.value = null
  }
}

function formatDateOrDash(value: string | Date | null | undefined): string {
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

// Read query params on mount so shared links land on the right filter.
onMounted(() => {
  const params = new URLSearchParams(window.location.search)
  const printer = Number(params.get('printer'))
  if (Number.isInteger(printer) && printer > 0) printerFilter.value = printer
  const mode = params.get('filter')
  if (mode === 'active' || mode === 'resolved' || mode === 'all') filterMode.value = mode
  void load()
})

watch([filterMode, printerFilter], () => {
  const params = new URLSearchParams(window.location.search)
  if (filterMode.value === 'all') params.delete('filter')
  else params.set('filter', filterMode.value)
  if (printerFilter.value) params.set('printer', String(printerFilter.value))
  else params.delete('printer')
  const next = `${window.location.pathname}${params.toString() ? '?' + params.toString() : ''}`
  window.history.replaceState(null, '', next)
})
</script>

<style scoped>
.maint-view {
  padding: 20px 24px;
  max-width: 1100px;
  margin: 0 auto;
  position: relative;
}

.maint-summary {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.maint-loading {
  display: flex;
  align-items: center;
  padding: 32px;
}

.maint-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 56px 16px;
  text-align: center;
}

.maint-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.maint-row {
  padding: 12px 14px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.maint-row--active {
  border-color: rgba(var(--v-theme-warning), 0.45);
  background: rgba(var(--v-theme-warning), 0.06);
}

.maint-row__header {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
}

.maint-row__printer {
  font-weight: 600;
}

.maint-row__cause {
  color: rgba(var(--v-theme-on-surface), 0.85);
}

.maint-row__completion {
  padding-left: 12px;
  border-left: 2px solid rgba(var(--v-theme-success), 0.5);
}

.maint-fab {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 5;
}
</style>
