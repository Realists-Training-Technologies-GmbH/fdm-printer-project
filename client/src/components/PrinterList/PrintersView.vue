<template>
  <div class="printers-view pa-4">
    <!-- ─── Header ──────────────────────────────────────────── -->
    <div class="pv-header">
      <div class="pv-header__title">
        <v-icon class="mr-2" color="primary">view_list</v-icon>
        <h2 class="text-h6 font-weight-bold mb-0">Printers</h2>
        <span class="text-body-2 text-medium-emphasis ml-3">
          {{ printers.length }} {{ printers.length === 1 ? 'printer' : 'printers' }}
        </span>
      </div>

      <v-spacer />

      <v-btn
        color="primary"
        variant="flat"
        size="small"
        prepend-icon="add"
        @click="openCreatePrinterDialog()"
      >
        Add printer
      </v-btn>

      <v-menu>
        <template #activator="{ props }">
          <v-btn
            v-bind="props"
            variant="tonal"
            size="small"
            icon="more_vert"
          >
            <v-icon>more_vert</v-icon>
            <v-tooltip activator="parent" location="bottom">More actions</v-tooltip>
          </v-btn>
        </template>
        <v-list density="compact" min-width="220">
          <v-list-item
            prepend-icon="label"
            title="Manage tags"
            @click="openManageTagsDialog()"
          />
          <v-list-item
            prepend-icon="code"
            title="Import / export YAML"
            @click="openYamlImportExportDialog()"
          />
          <v-list-item
            prepend-icon="publish"
            title="Import OctoFarm printers"
            @click="openImportOctoFarmPrintersDialog()"
          />
        </v-list>
      </v-menu>
    </div>

    <!-- ─── Filters ─────────────────────────────────────────── -->
    <v-card class="pv-filters" elevation="0" border>
      <div class="pv-filters__row">
        <v-text-field
          v-model="search"
          clearable
          placeholder="Search by name or URL…"
          prepend-inner-icon="search"
          density="compact"
          variant="outlined"
          hide-details
          class="pv-filter pv-filter--wide"
        />
      </div>
    </v-card>

    <!-- ─── Printer rows ────────────────────────────────────── -->
    <div v-if="printers.length === 0" class="pl-empty text-center py-10">
      <v-icon size="48" color="grey-lighten-1" class="mb-3">print_disabled</v-icon>
      <h3 class="text-subtitle-1 mb-3">
        {{ printerStore.printers.length === 0
          ? 'No printer has been created yet'
          : 'No printer matches your search' }}
      </h3>
      <PrinterCreateAction/>
    </div>

    <div v-else class="pl-list">
      <template v-for="printer in printers" :key="printer.id">
        <v-card class="pl-row" elevation="0">
          <span class="pl-row__accent" :style="stateInfoById[printer.id]?.accentStyle" />

          <v-switch
            :model-value="printer.enabled"
            color="primary"
            inset
            hide-details
            density="compact"
            class="pl-row__toggle flex-shrink-0"
            @click.stop="toggleEnabled(printer)"
          />

          <!-- Identity: name -->
          <div class="pl-row__identity">
            <span class="pl-row__name-text text-truncate" :title="printer.name || printer.printerURL">
              {{ printer.name || printer.printerURL }}
            </span>
          </div>

          <!-- Floor / Tags / Cameras (display chips only) -->
          <div v-if="floorOfPrinter(printer.id)" class="pl-chip-group">
            <v-chip
              closable
              size="small"
              @click="openFloorEditDialog(floorOfPrinter(printer.id)?.id)"
              @click:close="removePrinterFromFloor(printer.id)"
            >
              <v-icon start size="x-small">layers</v-icon>
              {{ floorOfPrinter(printer.id)?.name }}
            </v-chip>
          </div>

          <div v-if="tagsOfPrinter(printer.id).length" class="pl-chip-group">
            <v-chip
              v-for="tag of tagsOfPrinter(printer.id)"
              :key="tag.id"
              :color="tag.color"
              size="small"
              variant="tonal"
              closable
              @click="openManageTagsDialogAndEdit(tag.id)"
              @click:close="deletePrinterFromTag(tag.id, printer.id)"
            >
              <v-icon start size="x-small">label</v-icon>
              {{ tag.name }}
            </v-chip>
          </div>

          <div v-if="camerasOfPrinter(printer.id).length" class="pl-chip-group">
            <v-chip
              v-for="camera in camerasOfPrinter(printer.id).slice(0, 2)"
              :key="camera.id"
              size="x-small"
              variant="tonal"
              closable
              @click="openCameraEditDialog(camera.id)"
              @click:close="detachCameraFromPrinter(camera.id)"
            >
              <v-icon start size="x-small">videocam</v-icon>
              {{ camera.name }}
            </v-chip>
            <v-chip v-if="camerasOfPrinter(printer.id).length > 2" size="x-small" variant="text">
              +{{ camerasOfPrinter(printer.id).length - 2 }}
            </v-chip>
          </div>

          <!-- Status (right-aligned) -->
          <v-chip
            :color="stateInfoById[printer.id]?.color"
            size="x-small"
            variant="flat"
            class="pl-row__state flex-shrink-0"
          >
            {{ stateInfoById[printer.id]?.text }}
          </v-chip>

          <!-- Actions + add-tag + add-camera -->
          <div class="pl-row__actions">
            <FileExplorerAction :printer="printer"/>
            <PrinterSettingsAction :printer="printer" @update:show="openEditDialog(printer)"/>
            <PrinterDeleteAction :printer="printer"/>
            <PrinterMaintenanceAction :printer="printer"/>
            <PrinterUrlAction :printer="printer"/>
            <PrinterQuickStopAction :printer="printer"/>
            <PrinterConnectionAction :printer="printer"/>
            <SyncPrinterNameAction :printer="printer"/>

            <v-menu>
              <template #activator="{ props }">
                <v-btn v-bind="props" :disabled="!nonTagsOfPrinter(printer.id).length" size="small" icon variant="text">
                  <v-icon>new_label</v-icon>
                  <v-tooltip activator="parent" location="top">Add tag</v-tooltip>
                </v-btn>
              </template>
              <v-list density="compact" min-width="150">
                <v-list-subheader>Add Tag</v-list-subheader>
                <v-list-item v-for="(tag, index) in nonTagsOfPrinter(printer.id)" :key="index" @click="addPrinterToTag(tag.id, printer.id)">
                  <template #prepend>
                    <v-chip :color="tag.color" size="x-small" variant="flat" class="mr-2"><v-icon size="x-small">label</v-icon></v-chip>
                  </template>
                  <v-list-item-title>{{ tag.name }}</v-list-item-title>
                </v-list-item>
                <v-list-item v-if="!nonTagsOfPrinter(printer.id).length" disabled>
                  <v-list-item-title class="text-caption">All tags assigned</v-list-item-title>
                </v-list-item>
              </v-list>
            </v-menu>

            <v-menu>
              <template #activator="{ props }">
                <v-btn v-bind="props" :disabled="!availableCamerasForPrinter(printer.id).length" size="small" icon variant="text">
                  <v-icon>add_a_photo</v-icon>
                  <v-tooltip activator="parent" location="top">Attach camera</v-tooltip>
                </v-btn>
              </template>
              <v-list density="compact" min-width="180">
                <v-list-subheader>Attach Camera</v-list-subheader>
                <v-list-item v-for="camera in availableCamerasForPrinter(printer.id)" :key="camera.id" @click="attachCameraToPrinter(camera.id!, printer.id)">
                  <template #prepend>
                    <v-icon class="mr-2" size="small">videocam</v-icon>
                  </template>
                  <v-list-item-title>{{ camera.name || camera.streamURL }}</v-list-item-title>
                </v-list-item>
                <v-list-item v-if="!availableCamerasForPrinter(printer.id).length" disabled>
                  <v-list-item-title class="text-caption">No available cameras</v-list-item-title>
                </v-list-item>
              </v-list>
            </v-menu>
          </div>

          <!-- Floor / grid menu (three dots), before the expand dropdown -->
          <v-menu>
            <template #activator="{ props }">
              <v-btn v-bind="props" icon size="small" variant="text" class="pl-row__expand flex-shrink-0">
                <v-icon>more_vert</v-icon>
              </v-btn>
            </template>
            <v-list density="compact" min-width="200">
              <v-list-item prepend-icon="grid_on" @click="goToPrinterGrid(printer.id)">
                <v-list-item-title>{{ floorOfPrinter(printer.id) ? 'View Floor Grid' : 'View Printer Grid' }}</v-list-item-title>
              </v-list-item>
              <v-list-item v-if="floorOfPrinter(printer.id)" prepend-icon="edit" @click="openFloorEditDialog(floorOfPrinter(printer.id)?.id)">
                <v-list-item-title>Edit Floor</v-list-item-title>
              </v-list-item>
              <v-list-item prepend-icon="settings" @click="goToFloorSettings()">
                <v-list-item-title>Floor Settings</v-list-item-title>
              </v-list-item>
            </v-list>
          </v-menu>

          <v-btn
            icon
            size="small"
            variant="text"
            class="pl-row__expand flex-shrink-0"
            @click.stop="toggleExpand(printer.id)"
          >
            <v-icon>{{ isExpanded(printer.id) ? 'expand_less' : 'expand_more' }}</v-icon>
          </v-btn>
        </v-card>

        <v-expand-transition>
          <div v-if="isExpanded(printer.id)" class="pl-row__details">
            <PrinterDetails :printer="printer"/>
          </div>
        </v-expand-transition>
      </template>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { PrintersService } from '@/backend/printers.service'
import PrinterDetails from '@/components/PrinterList/PrinterDetails.vue'
import PrinterUrlAction from '@/components/Generic/Actions/PrinterUrlAction.vue'
import PrinterSettingsAction from '@/components/Generic/Actions/PrinterSettingsAction.vue'
import PrinterConnectionAction from '@/components/Generic/Actions/PrinterConnectionAction.vue'
import PrinterQuickStopAction from '@/components/Generic/Actions/PrinterQuickStopAction.vue'
import PrinterMaintenanceAction from '@/components/Generic/Actions/PrinterMaintenanceAction.vue'
import FileExplorerAction from '@/components/Generic/Actions/FileExplorerAction.vue'
import SyncPrinterNameAction from '@/components/Generic/Actions/SyncPrinterNameAction.vue'
import { usePrinterStore } from '@/store/printer.store'
import { DialogName } from '@/components/Generic/Dialogs/dialog.constants'
import PrinterCreateAction from '@/components/Generic/Actions/PrinterCreateAction.vue'
import PrinterDeleteAction from '@/components/Generic/Actions/PrinterDeleteAction.vue'
import { useFloorStore } from '@/store/floor.store'
import { usePrinterStateStore } from '@/store/printer-state.store'
import { PrinterDto } from '@/models/printers/printer.model'
import { useFeatureStore } from '@/store/features.store'
import { useQuery } from '@tanstack/vue-query'
import { useSnackbar } from '@/shared/snackbar.composable'
import { PrinterTagService } from '@/backend/printer-tag.service'
import { useDialog } from '@/shared/dialog.composable'
import { interpretStates } from '@/shared/printer-state.constants'
import { CameraStreamService } from '@/backend/camera-stream.service'
import { printerTagsQueryKey } from '@/queries/printer-tags.query'
import { usePrinterFilters } from '@/shared/printer-filter.composable'

const snackbar = useSnackbar()
const router = useRouter()
const printerStore = usePrinterStore()
const loading = ref<boolean>(false)
const printerStateStore = usePrinterStateStore()
const floorStore = useFloorStore()
const featureStore = useFeatureStore()

const addOrUpdatePrinterDialog = useDialog(DialogName.AddOrUpdatePrinterDialog)

const { tagsWithPrinters, loadTags, filterPrinters } = usePrinterFilters()

const cameras = ref<any[]>([])

const search = ref('')
const expanded = ref<number[]>([])

const toggleExpand = (printerId: number) => {
  const idx = expanded.value.indexOf(printerId)
  if (idx === -1) expanded.value.push(printerId)
  else expanded.value.splice(idx, 1)
}

const isExpanded = (printerId: number) => expanded.value.includes(printerId)

// Map each printer's interpreted live state to a bright theme token (for the
// row's left accent stripe and a status chip), matching the printer-grid
// visual language. interpretStates returns muted RGBs meant for tile
// backgrounds, so we re-map to theme colours here.
const stateInfoById = computed<Record<number, { color: string; text: string; accentStyle: Record<string, string> }>>(() => {
  const map: Record<number, { color: string; text: string; accentStyle: Record<string, string> }> = {}
  for (const printer of printers.value) {
    const events = printerStateStore.printerEventsById[printer.id]
    const socketState = printerStateStore.socketStatesById[printer.id]
    const s = interpretStates(printer, socketState, events)
    let color = 'info'
    if (!s) color = 'grey'
    else if (s.text === 'Printing') color = 'success'
    else if (s.text === 'Paused') color = 'warning'
    else if (s.text === 'Operational') color = 'primary'
    else if (s.color === 'danger') color = 'error'
    // Disabled / offline / API-unreachable ('secondary') stay muted grey
    // rather than the misleading "info" blue.
    else if (s.color === 'secondary' || s.text === 'Disabled') color = 'grey'
    map[printer.id] = {
      color,
      text: s?.text || 'Unknown',
      accentStyle: color === 'grey' ? {} : { '--state-color': `rgb(var(--v-theme-${color}))` }
    }
  }
  return map
})

async function loadData() {
  loading.value = true
  await featureStore.loadFeatures()
  await loadTags()

  cameras.value = await CameraStreamService.listCameraStreams()

  loading.value = false
  return tagsWithPrinters
}

const printerTagsQuery = useQuery({
  queryKey: [printerTagsQueryKey],
  queryFn: loadData
})

const printers = computed(() => {
  const base = filterPrinters(printerStore.printers)
  const q = search.value?.trim().toLowerCase()
  if (!q) return base
  return base.filter(
    (p) =>
      (p.name || '').toLowerCase().includes(q) ||
      (p.printerURL || '').toLowerCase().includes(q)
  )
})

const tagsOfPrinter = (printerId: number) => {
  return tagsWithPrinters.value.filter((g) =>
    g.printers.find((p) => p.printerId === printerId)
  )
}

const nonTagsOfPrinter = (printerId: number) => {
  return tagsWithPrinters.value.filter(
    (g) => !g.printers.some((p) => p.printerId === printerId)
  )
}

const floorOfPrinter = (printerId: number) => {
  return floorStore.floorOfPrinter(printerId)
}

const camerasOfPrinter = (printerId: number) => {
  return cameras.value.filter(camera => camera.printerId === printerId)
}

const availableCamerasForPrinter = (printerId: number) => {
  return cameras.value.filter(camera => camera.printerId !== printerId)
}

const openEditDialog = (printer: PrinterDto) => {
  addOrUpdatePrinterDialog.openDialog({ id: printer.id })
}

const openCreatePrinterDialog = () => {
  addOrUpdatePrinterDialog.openDialog()
}

const openImportOctoFarmPrintersDialog = () => {
  useDialog(DialogName.ImportOctoFarmDialog).openDialog()
}

const openYamlImportExportDialog = () => {
  useDialog(DialogName.YamlImportExport).openDialog()
}

const openManageTagsDialog = () => {
  useDialog(DialogName.ManageTagsDialog).openDialog()
}

const openManageTagsDialogAndEdit = (tagId: number) => {
  const tag = tagsWithPrinters.value.find(t => t.id === tagId)
  if (tag) {
    const manageTagsDialog = useDialog(DialogName.ManageTagsDialog)
    manageTagsDialog.openDialog({ tagId, tagName: tag.name })
  }
}

const goToPrinterGrid = (printerId: number) => {
  const floor = floorOfPrinter(printerId)
  if (floor) {
    router.push({
      path: '/printer-grid',
      query: { floor: floor.id.toString() }
    })
  } else {
    router.push('/printer-grid')
  }
}

const goToFloorSettings = () => {
  router.push('/settings/floors')
}

const openFloorEditDialog = (floorId?: number) => {
  if (floorId) {
    useDialog(DialogName.AddOrUpdateFloorDialog).openDialog({ printerFloorId: floorId })
  }
}

const openCameraEditDialog = (cameraId?: number) => {
  if (cameraId) {
    useDialog(DialogName.AddOrUpdateCameraDialog).openDialog({ addOrUpdate: 'update', cameraId })
  }
}

const addPrinterToTag = async (tagId: number, printerId: number) => {
  await PrinterTagService.addPrinterToTag(tagId, printerId)
  await printerTagsQuery.refetch()
  snackbar.info('Added printer to tag')
}

const deletePrinterFromTag = async (tagId: number, printerId: number) => {
  await PrinterTagService.deletePrinterTag(tagId, printerId)
  await printerTagsQuery.refetch()
  snackbar.info('Removed printer from tag')
}

const removePrinterFromFloor = async (printerId: number) => {
  const floor = floorOfPrinter(printerId)
  if (!floor) {
    snackbar.error('Printer is not assigned to any floor')
    return
  }

  if (!confirm(`Remove printer from floor "${ floor.name }"?`)) {
    return
  }

  await floorStore.deletePrinterFromFloor({
    floorId: floor.id,
    printerId
  })
  snackbar.info('Removed printer from floor')
}

const toggleEnabled = async (printer: PrinterDto) => {
  if (!printer.id) {
    throw new Error('Printer ID not set, cant toggle enabled')
  }

  printer.enabled = !printer.enabled
  await PrintersService.toggleEnabled(printer.id, printer.enabled)
}

const attachCameraToPrinter = async (cameraId: number, printerId: number) => {
  const camera = cameras.value.find(c => c.id === cameraId)
  if (!camera) {
    snackbar.error('Camera not found')
    return
  }

  await CameraStreamService.updateCameraStream(cameraId, {
    streamURL: camera.streamURL,
    name: camera.name,
    printerId,
    aspectRatio: camera.aspectRatio,
    rotationClockwise: camera.rotationClockwise,
    flipHorizontal: camera.flipHorizontal,
    flipVertical: camera.flipVertical
  })

  camera.printerId = printerId
  snackbar.info('Attached camera to printer')
}

const detachCameraFromPrinter = async (cameraId: number) => {
  const camera = cameras.value.find(c => c.id === cameraId)
  if (!camera) {
    snackbar.error('Camera not found')
    return
  }

  await CameraStreamService.updateCameraStream(cameraId, {
    streamURL: camera.streamURL,
    name: camera.name,
    printerId: undefined,
    aspectRatio: camera.aspectRatio,
    rotationClockwise: camera.rotationClockwise,
    flipHorizontal: camera.flipHorizontal,
    flipVertical: camera.flipVertical
  })

  camera.printerId = undefined
  snackbar.info('Detached camera from printer')
}
</script>

<style lang="scss">
.disabled-highlight tbody {
  tr:hover {
    background-color: transparent !important;
  }
}

.reorder-row-icon {
  cursor: move;
}

.printers-view {
  .pv-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));

    &__title {
      display: flex;
      align-items: center;
    }
  }

  .pv-filters {
    padding: 12px 16px;
    margin-bottom: 16px;
    background: rgb(var(--v-theme-surface));

    &__row {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: flex-start;
    }
  }

  .pv-filter {
    flex: 1 1 200px;
    min-width: 180px;
    max-width: 280px;

    &--wide {
      flex: 1 1 320px;
      min-width: 240px;
      max-width: none;
    }
  }

  /* ─── Printer rows ──────────────────────────────────────── */
  .pl-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .pl-row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 10px 6px 16px;
    background: rgb(var(--v-theme-surface));
    color: rgb(var(--v-theme-on-surface));
    border: 1px solid rgba(var(--v-theme-on-surface), 0.06);
    overflow: hidden;
  }

  .pl-row__accent {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 4px;
    background: var(--state-color, rgba(var(--v-theme-on-surface), 0.12));
  }

  .pl-row__toggle {
    flex: 0 0 auto;
  }

  /* Identity: printer name */
  .pl-row__identity {
    display: flex;
    align-items: center;
    flex: 0 1 auto;
    min-width: 0;
  }

  .pl-row__name-text {
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 14px;
    font-weight: 600;
  }

  /* Status chip, pushed to the right edge before the action icons */
  .pl-row__state {
    margin-left: auto;
    flex: 0 0 auto;
    font-weight: 700;
    letter-spacing: 0.02em;
  }

  .pl-chip-group {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 0 0 auto;
  }

  .pl-row__actions {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 0 0 auto;

    /* The shared action components render as heavy elevated `bg-secondary`
       pills (with `ms-4` spacing). In this list we want light, flat icon
       buttons, so flatten them here without touching the shared components. */
    .v-btn {
      margin: 0 !important;
      min-width: 0 !important;
      padding: 0 8px !important;
      background: transparent !important;
      box-shadow: none !important;
      color: rgba(var(--v-theme-on-surface), 0.65) !important;

      &:hover {
        background: rgba(var(--v-theme-on-surface), 0.08) !important;
        color: rgb(var(--v-theme-on-surface)) !important;
      }
    }
  }

  .pl-row__expand {
    flex: 0 0 auto;
  }

  .pl-row__details {
    padding: 0 12px 12px 16px;
  }
}
</style>
