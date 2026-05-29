<template>
  <v-dialog v-model="visible" max-width="640" scrollable>
    <v-card>
      <v-card-title class="d-flex align-center justify-space-between">
        <div class="text-truncate">
          <v-icon class="mr-2" color="primary">image</v-icon>
          <span>{{ printerName }}</span>
        </div>
        <v-btn icon="close" variant="text" size="small" @click="visible = false" />
      </v-card-title>

      <v-divider />

      <v-card-text class="pa-0">
        <div class="ptp-preview">
          <v-img
            v-if="thumbnail?.length"
            :src="'data:image/png;base64,' + thumbnail"
            max-height="380"
            contain
            class="ptp-preview__img"
          />
          <div v-else class="ptp-preview__empty">
            <v-icon size="56" color="medium-emphasis">image_not_supported</v-icon>
            <p class="text-body-2 text-medium-emphasis mt-2">
              No preview available for this print
            </p>
          </div>
        </div>

        <div class="pa-4">
          <div class="text-overline text-medium-emphasis">File</div>
          <div
            class="text-body-1 text-truncate"
            :title="fileName ?? ''"
          >
            {{ fileName ?? '—' }}
          </div>

          <v-row class="mt-2" no-gutters>
            <v-col cols="6" class="pe-2">
              <div class="text-caption text-medium-emphasis">Estimated time</div>
              <div class="text-body-2">{{ formatDuration(estimatedSeconds) }}</div>
            </v-col>
            <v-col cols="6" class="ps-2">
              <div class="text-caption text-medium-emphasis">Time remaining</div>
              <div class="text-body-2">{{ formatDuration(remainingSeconds) }}</div>
            </v-col>

            <v-col cols="6" class="pe-2 mt-3">
              <div class="text-caption text-medium-emphasis">Filament</div>
              <div class="text-body-2">{{ filamentDescription }}</div>
            </v-col>
            <v-col cols="6" class="ps-2 mt-3">
              <div class="text-caption text-medium-emphasis">Printer model</div>
              <div class="text-body-2">{{ metadata?.printerModel ?? '—' }}</div>
            </v-col>

            <v-col cols="6" class="pe-2 mt-3">
              <div class="text-caption text-medium-emphasis">Layer height</div>
              <div class="text-body-2">
                {{ metadata?.layerHeight ? `${metadata.layerHeight} mm` : '—' }}
              </div>
            </v-col>
            <v-col cols="6" class="ps-2 mt-3">
              <div class="text-caption text-medium-emphasis">Nozzle / Bed</div>
              <div class="text-body-2">
                {{ metadata?.nozzleTemperature ?? '—' }}° /
                {{ metadata?.bedTemperature ?? '—' }}°
              </div>
            </v-col>
          </v-row>
        </div>
      </v-card-text>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const visible = defineModel<boolean>({ required: true })

interface JobMetadata {
  gcodePrintTimeSeconds?: number | null
  filamentUsedGrams?: number | number[] | null
  filamentType?: string | null
  printerModel?: string | null
  layerHeight?: number | null
  nozzleTemperature?: number | null
  bedTemperature?: number | null
}

const props = defineProps<{
  printerName?: string | null
  fileName?: string | null
  thumbnail?: string | null
  estimatedSeconds?: number | null
  remainingSeconds?: number | null
  metadata?: JobMetadata | null
}>()

const formatDuration = (seconds: number | null | undefined): string => {
  if (!seconds || seconds <= 0) return '—'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m`
  return `${Math.floor(seconds)}s`
}

// Filament-used can arrive as a single number (single-extruder print) or an
// array (MMU with one entry per filament). Sum the array so the user sees the
// total without losing the multi-material context. Append the filament type
// when known so "12g · PLA" gives the operator both numbers at a glance.
const filamentDescription = computed<string>(() => {
  const m = props.metadata
  const used = m?.filamentUsedGrams
  if (used == null) return m?.filamentType ?? '—'
  const grams = Array.isArray(used) ? used.reduce((a, b) => a + b, 0) : used
  const formatted = Number.isFinite(grams) ? `${Math.round(grams)} g` : '—'
  return m?.filamentType ? `${formatted} · ${m.filamentType}` : formatted
})
</script>

<style scoped>
.ptp-preview {
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.25);
  min-height: 240px;
}

.ptp-preview__img {
  width: 100%;
}

.ptp-preview__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 48px 16px;
}
</style>
