<template>
  <div class="pg-summary">
    <!-- Total -->
    <span class="pg-summary__total" :title="'Total printers'">
      <v-icon size="16" class="pg-summary__total-icon">precision_manufacturing</v-icon>
      {{ counts.total }} printer{{ counts.total === 1 ? '' : 's' }}
    </span>

    <!-- Counts. Each pill is only rendered when non-zero so the bar stays
         tight when the farm is mostly idle. -->
    <v-chip
      v-if="counts.printing > 0"
      size="small"
      color="success"
      variant="tonal"
      density="comfortable"
      :title="'Currently printing'"
    >
      <v-icon size="14" start>play_arrow</v-icon>
      {{ counts.printing }} printing
    </v-chip>

    <v-chip
      v-if="counts.transferring > 0"
      size="small"
      color="info"
      variant="tonal"
      density="comfortable"
      :title="'Files being transferred to printers right now'"
    >
      <v-icon size="14" start>cloud_upload</v-icon>
      {{ counts.transferring }} transferring
    </v-chip>

    <v-chip
      v-if="counts.paused > 0"
      size="small"
      color="warning"
      variant="tonal"
      density="comfortable"
      :title="'Print paused'"
    >
      <v-icon size="14" start>pause</v-icon>
      {{ counts.paused }} paused
    </v-chip>

    <v-chip
      v-if="counts.idle > 0"
      size="small"
      color="grey"
      variant="tonal"
      density="comfortable"
      :title="'Online and ready for the next job'"
    >
      <v-icon size="14" start>check_circle</v-icon>
      {{ counts.idle }} idle
    </v-chip>

    <v-chip
      v-if="counts.attention > 0"
      size="small"
      color="warning"
      variant="tonal"
      density="comfortable"
      :title="'Printer reports an attention state (filament runout, door open, etc.)'"
    >
      <v-icon size="14" start>priority_high</v-icon>
      {{ counts.attention }} attention
    </v-chip>

    <v-chip
      v-if="counts.maintenance > 0"
      size="small"
      color="warning"
      variant="tonal"
      density="comfortable"
      :title="'Disabled with a maintenance reason'"
    >
      <v-icon size="14" start>construction</v-icon>
      {{ counts.maintenance }} maintenance
    </v-chip>

    <v-chip
      v-if="counts.offline > 0"
      size="small"
      color="error"
      variant="tonal"
      density="comfortable"
      :title="'Network unreachable or auth failure'"
    >
      <v-icon size="14" start>wifi_off</v-icon>
      {{ counts.offline }} offline
    </v-chip>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { usePrinterStore } from '@/store/printer.store'
import { usePrinterStateStore } from '@/store/printer-state.store'

const printerStore = usePrinterStore()
const printerStateStore = usePrinterStateStore()

// Single computed walk over the printer list so each chip pulls from the
// same snapshot — avoids the "printing + idle + offline doesn't add up to
// total" rounding artifact you'd see if each chip ran an independent pass
// while the underlying store updated mid-render.
const counts = computed(() => {
  const printers = printerStore.printers
  let printing = 0
  let paused = 0
  let idle = 0
  let attention = 0
  let offline = 0
  let maintenance = 0

  for (const printer of printers) {
    if (!printer.enabled) {
      if (printer.disabledReason?.length) {
        maintenance++
      } else {
        // Disabled without a reason is closer to "shelf-parked" than
        // "broken" — bucket alongside offline so it's not silently lost.
        offline++
      }
      continue
    }

    const socketState = printerStateStore.socketStatesById[printer.id]
    if (socketState?.api !== 'responding') {
      offline++
      continue
    }

    const flags =
      printerStateStore.printerEventsById[printer.id]?.current?.payload?.state
        ?.flags
    if (flags?.printing) {
      printing++
    } else if (flags?.paused || flags?.pausing) {
      paused++
    } else if (
      // Vuetify icon `priority_high` will only be useful when the firmware
      // is actually flagging an issue. PrusaLink uses ATTENTION; other
      // vendors use distinct flags, so check whichever shape arrived.
      (flags as any)?.attention ||
      (printerStateStore.printerEventsById[printer.id]?.current?.payload
        ?.state?.text || '')
        .toUpperCase()
        .startsWith('ATTENTION')
    ) {
      attention++
    } else if (flags?.operational) {
      idle++
    } else {
      // Online but no operational flag → treat as offline-ish so the user
      // doesn't see a chip that doesn't account for them.
      offline++
    }
  }

  // Active transfers — sourced from the queue dispatch progress map.
  const transferring = Object.keys(
    printerStateStore.queueUploadsByPrinterId,
  ).length

  return {
    total: printers.length,
    printing,
    transferring,
    paused,
    idle,
    attention,
    maintenance,
    offline,
  }
})
</script>

<style scoped>
.pg-summary {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(255, 255, 255, 0.02);
}

.pg-summary__total {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-weight: 600;
  margin-right: 8px;
  color: rgba(var(--v-theme-on-surface), 0.85);
}

.pg-summary__total-icon {
  margin-right: 2px;
}
</style>
