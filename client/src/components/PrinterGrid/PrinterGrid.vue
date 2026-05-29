<template>
  <div>
    <div class="printer-grid-container">
      <div
        class="printer-grid"
        :style="gridStyle"
      >
        <div
          v-for="index in totalCells"
          :key="`printer-${getX(index - 1)}-${getY(index - 1)}`"
          class="printer-cell"
          :class="{
            'printer-cell-large': largeTileMode
          }"
        >
          <PrinterGridTile
            :printer="getPrinter(getX(index - 1), getY(index - 1))"
            :x="getX(index - 1)"
            :y="getY(index - 1)"
          />
        </div>
      </div>
    </div>

    <!-- Drop zone for removing printers from grid - only show when dragging placed printers -->
    <div
      v-show="isDraggingPlacedPrinter"
      class="remove-drop-zone"
      @dragover.prevent
      @dragenter.prevent="onDragEnterRemove"
      @dragleave.prevent="onDragLeaveRemove"
      @drop.prevent="onDropRemove"
    >
      <v-icon size="large" class="mr-2">delete_forever</v-icon>
      <span class="text-h6">Drop here to remove from grid</span>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed, onMounted, ref } from 'vue'
import PrinterGridTile from '@/components/PrinterGrid/PrinterGridTile.vue'
import { usePrinterStore } from '@/store/printer.store'
import { dragAppId, INTENT, DRAG_EVENTS } from '@/shared/drag.constants'
import { useSettingsStore } from '@/store/settings.store'
import { useFloorStore } from '@/store/floor.store'
import { FloorService } from '@/backend/floor.service'
import { usePrinterFilters } from '@/shared/printer-filter.composable'
import { useGridStore } from '@/store/grid.store'

const printerStore = usePrinterStore()
const floorStore = useFloorStore()
const settingsStore = useSettingsStore()
const gridStore = useGridStore()
const isDragging = ref(false)
const isDraggingPlacedPrinter = ref(false)
const isOverRemoveZone = ref(false)

const { loadTags, filterPrinterMatrix, filterPrinters } = usePrinterFilters()

// Track when dragging placed vs unplaced printers
globalThis.addEventListener('dragstart', () => {
  isDragging.value = true
})
globalThis.addEventListener('dragend', () => {
  isDragging.value = false
  isDraggingPlacedPrinter.value = false
})

// Custom event from tiles to indicate dragging a placed printer
globalThis.addEventListener(DRAG_EVENTS.TILE_DRAG_START, () => {
  isDraggingPlacedPrinter.value = true
})

onMounted(async () => {
  await printerStore.loadPrinters()
  await floorStore.loadFloors()
  await loadTags()
})

const props = defineProps({
  gap: {
    type: String,
    default: '4px'
  }
})

const printerMatrix = computed(() => {
  if (gridStore.sortMode === 'name') {
    const filteredPrinters = filterPrinters(printerStore.printers)
    return floorStore.gridNameSortedPrinters(filteredPrinters)
  }

  return filterPrinterMatrix(floorStore.gridSortedPrinters)
})
const columns = computed(() => settingsStore.gridCols)
const rows = computed(() => settingsStore.gridRows)
const largeTileMode = computed(() => settingsStore.largeTiles)

const totalCells = computed(() => rows.value * columns.value)
const gridStyle = computed(() => ({
  display: 'grid',
  // `minmax(0, 1fr)` instead of bare `1fr` is the canonical fix for
  // long-content cells overflowing their track — without the explicit
  // 0 minimum the grid algorithm respects each cell's min-content size
  // and lets it push the column wider than 1fr.
  gridTemplateColumns: `repeat(${ columns.value }, minmax(0, 1fr))`,
  gap: props.gap
}))

const getX = (index: number) => index % columns.value
const getY = (index: number) => Math.floor(index / columns.value)

function getPrinter(col: number, row: number) {
  const x = col
  const y = row
  if (!printerMatrix.value?.length || !printerMatrix.value[x]) return undefined
  return printerMatrix.value[x][y]
}

function onDragEnterRemove() {
  isOverRemoveZone.value = true
}

function onDragLeaveRemove() {
  isOverRemoveZone.value = false
}

async function onDropRemove(ev: DragEvent) {
  isOverRemoveZone.value = false

  if (!ev.dataTransfer) return

  try {
    const data = JSON.parse(ev.dataTransfer.getData('text'))
    if (data.appId !== dragAppId || data.intent !== INTENT.PRINTER_PLACE) return

    const printerId = data.printerId
    if (!printerId || !floorStore.selectedFloor) return

    // Remove printer from floor
    await FloorService.deletePrinterFromFloor(floorStore.selectedFloor.id, printerId)
    await floorStore.loadFloors()
  } catch (e) {
    console.error('Failed to remove printer from grid:', e)
  }
}

</script>

<style scoped>
.remove-drop-zone {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  height: 80px;
  background-color: rgba(211, 47, 47, 0.3);
  border-top: 3px dashed rgba(211, 47, 47, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  transition: background-color 0.2s;
  backdrop-filter: blur(4px);
}

.remove-drop-zone:hover {
  background-color: rgba(211, 47, 47, 0.5);
}

.printer-grid-container {
  width: 100%;
}

.printer-grid {
  width: 100%;
}

.printer-cell {
  padding: 4px;
  /* Grid items default to min-width: auto, which equals the content's
     intrinsic width. With a long file name in the tile that pushes the
     cell past its `1fr` track and clips into the next column. Forcing
     min-width: 0 lets text-truncate inside the tile actually kick in. */
  min-width: 0;
}

.printer-cell-large {
  padding: 8px;
}

/* Responsive collapse: on a narrow viewport the user's chosen column
   count would jam tiles together. Below 900px, fall back to a single
   column regardless of grid-template-columns set inline. Tablet-sized
   screens (≤ 1280px) drop to a 2-column ceiling so denser layouts
   don't clip on a laptop side-by-side window. */
@media (max-width: 900px) {
  .printer-grid {
    grid-template-columns: 1fr !important;
  }
}
@media (min-width: 901px) and (max-width: 1280px) {
  .printer-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
  }
}

</style>
