<template>
  <v-container
    fluid
    class="files-view pa-4"
    :class="{ 'files-view--dragging': isDragging }"
    @dragenter.prevent="handleDragEnter"
    @dragover.prevent="handleDragOver"
    @dragleave.prevent="handleDragLeave"
    @drop.prevent="handleDrop"
  >
    <!-- ─── Header ──────────────────────────────────────────── -->
    <div class="files-header">
      <div class="files-header__title">
        <v-icon class="mr-2" color="primary">inventory_2</v-icon>
        <h2 class="text-h6 font-weight-bold mb-0">File storage</h2>
        <span
          v-if="totalCount > 0"
          class="text-body-2 text-medium-emphasis ml-3"
        >
          {{ totalCount }} {{ totalCount === 1 ? 'file' : 'files' }}
        </span>
      </div>

      <v-spacer />

      <v-text-field
        v-model="searchQuery"
        prepend-inner-icon="search"
        placeholder="Search files…"
        variant="outlined"
        density="compact"
        hide-details
        clearable
        class="files-header__search"
      />

      <input
        ref="fileInput"
        type="file"
        multiple
        accept=".gcode,.3mf,.bgcode"
        style="display: none"
        @change="handleFileSelect"
      />

      <!-- Folder picker: webkitdirectory makes the OS open a directory chooser
           and tags each file with a webkitRelativePath so we can recreate the
           folder tree on upload. -->
      <input
        ref="folderInput"
        type="file"
        webkitdirectory
        multiple
        style="display: none"
        @change="handleFolderSelect"
      />

      <v-btn
        variant="tonal"
        size="small"
        prepend-icon="create_new_folder"
        @click="openCreateFolderDialog()"
      >
        New folder
      </v-btn>

      <v-btn
        color="primary"
        variant="flat"
        size="small"
        :loading="uploading"
        prepend-icon="upload"
        @click="fileInput?.click()"
      >
        Upload{{ currentFolderPath ? ` to ${folderBreadcrumb[folderBreadcrumb.length - 1]?.name || '/'}` : '' }}
      </v-btn>

      <v-btn
        color="primary"
        variant="tonal"
        size="small"
        :loading="uploading"
        prepend-icon="drive_folder_upload"
        @click="folderInput?.click()"
      >
        Upload folder
      </v-btn>

      <v-btn
        v-if="currentFolderPath !== null"
        variant="tonal"
        size="small"
        prepend-icon="folder_zip"
        :loading="exportingPath === currentFolderPath"
        @click="exportCurrentFolder()"
      >
        Export ZIP
      </v-btn>

      <v-btn
        :loading="loading"
        variant="tonal"
        size="small"
        icon="refresh"
        @click="loadFiles"
      >
        <v-icon>refresh</v-icon>
        <v-tooltip activator="parent" location="bottom">Refresh</v-tooltip>
      </v-btn>
    </div>

    <!-- ─── Breadcrumb ──────────────────────────────────────── -->
    <div class="files-breadcrumb">
      <v-btn
        size="small"
        variant="text"
        :class="{ 'files-breadcrumb__drop': isFileDragging && dragOverFolderPath === '__root__' }"
        :disabled="currentFolderPath === null"
        prepend-icon="home"
        @click="navigateToFolder(null)"
        @dragover.prevent="onFolderDragOver('__root__', $event)"
        @dragleave="onFolderDragLeave('__root__')"
        @drop.prevent="onFolderDrop(null)"
      >
        Root
      </v-btn>
      <template
        v-for="(crumb, idx) in folderBreadcrumb"
        :key="crumb.path"
      >
        <v-icon size="small" class="text-medium-emphasis">chevron_right</v-icon>
        <v-btn
          size="small"
          variant="text"
          :disabled="idx === folderBreadcrumb.length - 1"
          @click="navigateToFolder(crumb.path)"
        >
          {{ crumb.name }}
        </v-btn>
      </template>
    </div>

    <!-- ─── Drag overlay (covers full view while dragging) ──── -->
    <div
      v-if="isDragging"
      class="files-drag-overlay"
    >
      <v-icon size="80" color="primary">cloud_upload</v-icon>
      <div class="text-h6 mt-3">Drop files to upload</div>
      <div class="text-body-2 text-medium-emphasis mt-1">
        .gcode, .3mf, .bgcode
      </div>
    </div>

    <!-- ─── Upload progress (single aggregate bar while uploading) ── -->
    <v-card
      v-if="uploading && uploadProgress.length > 0"
      class="files-upload-progress"
      elevation="0"
      border
    >
      <div class="files-upload-progress__title">
        <v-icon size="small">upload</v-icon>
        Uploading {{ uploadDoneCount }} / {{ uploadProgress.length }}
        <span v-if="uploadErroredCount > 0" class="text-error ml-2">· {{ uploadErroredCount }} failed</span>
      </div>
      <v-progress-linear
        :model-value="uploadProgress.length ? (uploadDoneCount / uploadProgress.length) * 100 : 0"
        color="primary"
        height="8"
        rounded
      />
      <div v-if="currentUploadName" class="files-upload-progress__current text-caption text-truncate">
        {{ currentUploadName }}
      </div>
    </v-card>

    <!-- ─── Upload result (persists until dismissed when there are issues) ── -->
    <v-card
      v-else-if="!uploading && uploadErrored.length > 0"
      class="files-upload-progress"
      elevation="0"
      border
    >
      <div class="files-upload-progress__title">
        <v-icon size="small" color="warning">report_problem</v-icon>
        Upload finished — {{ uploadOkCount }} uploaded, {{ uploadErrored.length }} not uploaded
        <v-spacer />
        <v-btn icon size="x-small" variant="text" @click="uploadProgress = []">
          <v-icon>close</v-icon>
          <v-tooltip activator="parent" location="top">Dismiss</v-tooltip>
        </v-btn>
      </div>
      <div class="files-upload-progress__errors">
        <div v-for="(e, i) in uploadErrored" :key="i" class="files-upload-progress__error">
          <v-icon size="x-small" :color="e.error === 'Already exists' ? 'warning' : 'error'" class="flex-shrink-0">
            {{ e.error === 'Already exists' ? 'content_copy' : 'error' }}
          </v-icon>
          <span class="text-truncate">{{ e.fileName }}</span>
          <span class="files-upload-progress__error-tag text-caption">{{ e.error }}</span>
        </div>
      </div>
    </v-card>

    <!-- ─── Files table ─────────────────────────────────────── -->
    <v-card elevation="0" border>
      <v-card-text class="pa-0">
        <!-- ─── Bulk action bar (shows when there's selection) ── -->
        <div v-if="selectedCount > 0" class="files-bulk-bar">
          <v-chip color="primary" variant="flat" size="small" class="font-weight-bold">
            {{ selectedCount }} selected
          </v-chip>
          <v-spacer />
          <v-btn
            variant="tonal"
            size="small"
            prepend-icon="drive_file_move"
            @click="openBulkMoveDialog()"
          >
            Move
          </v-btn>
          <v-btn
            color="error"
            variant="tonal"
            size="small"
            prepend-icon="delete"
            :loading="bulkDeleting"
            @click="bulkDeleteSelected()"
          >
            Delete
          </v-btn>
          <v-btn
            variant="text"
            size="small"
            prepend-icon="close"
            @click="clearSelection()"
          >
            Clear
          </v-btn>
        </div>

        <!-- ─── Select-all header (above folders + files) ──── -->
        <div v-if="!loading && (folders.length > 0 || paginatedFiles.length > 0)" class="fl-head">
          <v-checkbox-btn
            :model-value="allSelected"
            :indeterminate="someSelected"
            density="compact"
            hide-details
            class="fl-row__check"
            @update:model-value="toggleSelectAll"
          />
          <span class="text-caption text-medium-emphasis">
            <template v-if="folders.length">{{ folders.length }} {{ folders.length === 1 ? 'folder' : 'folders' }} · </template>
            {{ filteredFiles.length }} {{ filteredFiles.length === 1 ? 'file' : 'files' }}
          </span>
        </div>

        <!-- ─── Folders, vertical, merged above the file list ──── -->
        <div
          v-if="currentFolderPath !== null || folders.length > 0"
          class="files-fs-list"
        >
          <!-- Up one level -->
          <div
            v-if="currentFolderPath !== null"
            class="files-fs-row files-fs-row--up"
            @click="navigateToParent()"
          >
            <span class="fl-row__check fl-row__check--spacer" />
            <v-icon size="20" class="files-fs-row__icon">drive_folder_upload</v-icon>
            <span class="files-fs-row__name">..</span>
            <span class="files-fs-row__type text-caption text-medium-emphasis">Parent folder</span>
            <span class="files-fs-row__menu-spacer" />
          </div>

          <div
            v-for="folder in folders"
            :key="folder.path"
            class="files-fs-row"
            :class="{
              'files-fs-row--drop': isFileDragging && dragOverFolderPath === folder.path,
              'files-fs-row--selected': isFolderSelected(folder.path),
            }"
            @click="navigateToFolder(folder.path)"
            @dragover.prevent="onFolderDragOver(folder.path, $event)"
            @dragleave="onFolderDragLeave(folder.path)"
            @drop.prevent="onFolderDrop(folder.path)"
          >
            <v-checkbox-btn
              :model-value="isFolderSelected(folder.path)"
              density="compact"
              hide-details
              class="fl-row__check"
              @update:model-value="toggleFolderSelect(folder.path)"
              @click.stop
            />
            <v-icon size="20" class="files-fs-row__icon">folder</v-icon>
            <span class="files-fs-row__name text-truncate" :title="folder.name">
              {{ folder.name }}
            </span>
            <span class="files-fs-row__type text-caption text-medium-emphasis">Folder</span>
            <v-menu @click.stop>
              <template #activator="{ props }">
                <button
                  type="button"
                  class="files-folder__menu"
                  aria-label="Folder actions"
                  v-bind="props"
                  @click.stop
                >
                  <v-icon size="16">more_vert</v-icon>
                </button>
              </template>
              <v-list density="compact" min-width="200">
                <v-list-item
                  prepend-icon="folder_zip"
                  title="Export as ZIP"
                  :disabled="exportingPath === folder.path"
                  @click="exportFolder(folder)"
                />
                <v-list-item
                  prepend-icon="drive_file_move"
                  title="Move"
                  @click="moveFolderSingle(folder)"
                />
                <v-list-item
                  prepend-icon="drive_file_rename_outline"
                  title="Rename"
                  @click="openRenameFolder(folder)"
                />
                <v-list-item
                  prepend-icon="delete"
                  title="Delete"
                  base-color="error"
                  @click="confirmDeleteFolder(folder)"
                />
              </v-list>
            </v-menu>
          </div>
        </div>

        <!-- ─── Loading ──── -->
        <div v-if="loading" class="fl-list">
          <v-skeleton-loader v-for="n in 5" :key="n" type="list-item-avatar-two-line" />
        </div>

        <!-- ─── Empty ──── -->
        <div v-else-if="filteredFiles.length === 0" class="text-center py-10">
          <v-icon size="48" color="grey-lighten-1" class="mb-3">folder_off</v-icon>
          <h3 class="text-subtitle-1">No files found</h3>
        </div>

        <!-- ─── File rows ──── -->
        <div v-else class="fl-list">
          <div
            v-for="file in paginatedFiles"
            :key="file.fileStorageId"
            class="fl-row"
            :class="{ 'fl-row--selected': isSelected(file.fileStorageId) }"
          >
            <span class="fl-row__accent" :style="{ '--state-color': fileFormatAccent(file.fileFormat) }" />

            <v-checkbox-btn
              :model-value="isSelected(file.fileStorageId)"
              density="compact"
              hide-details
              class="fl-row__check flex-shrink-0"
              @update:model-value="toggleSelect(file.fileStorageId)"
              @click.stop
            />

            <FileThumbnailCell
              class="fl-row__thumb flex-shrink-0"
              :file-storage-id="file.fileStorageId"
              :thumbnails="file.thumbnails || []"
              @click.stop
            />

            <div
              class="fl-row__main"
              draggable="true"
              @dragstart="onFileDragStart(file, $event)"
              @dragend="onFileDragEnd()"
            >
              <div class="fl-row__name">
                <v-icon size="x-small" class="fl-row__drag flex-shrink-0">drag_indicator</v-icon>
                <span class="text-truncate" :title="displayFileName(file)">{{ displayFileName(file) }}</span>
              </div>
              <div class="fl-row__sub">
                {{ file.fileFormat.toUpperCase() }} · {{ formatFileSize(file.fileSize) }} · {{ formatRelativeTime(file.createdAt) }}
              </div>
            </div>

            <!-- Meta chips -->
            <div class="fl-row__meta">
              <v-chip v-if="file.metadata?.filamentType" size="x-small" variant="tonal" color="orange">
                {{ Array.isArray(file.metadata.filamentType) ? file.metadata.filamentType.join(', ') : file.metadata.filamentType }}
              </v-chip>
              <v-chip v-if="file.metadata?.printerModel" size="x-small" variant="tonal" color="primary">
                <v-icon start size="x-small">print</v-icon>{{ file.metadata.printerModel }}
              </v-chip>
              <v-chip v-if="file.metadata?.layerHeight" size="x-small" variant="tonal">
                <v-icon start size="x-small">height</v-icon>{{ file.metadata.layerHeight }}mm
              </v-chip>
              <v-chip v-if="file.metadata?.gcodePrintTimeSeconds" size="x-small" variant="tonal" color="info">
                <v-icon start size="x-small">schedule</v-icon>{{ formatDuration(file.metadata.gcodePrintTimeSeconds) }}
              </v-chip>
              <v-chip v-if="file.metadata?.filamentUsedGrams != null" size="x-small" variant="tonal" color="green">
                <v-icon start size="x-small">fitness_center</v-icon>{{ fileFilamentText(file) }}
              </v-chip>
              <v-chip v-if="(file.metadata?.totalPlates ?? 1) > 1" size="x-small" variant="tonal" color="blue">
                <v-icon start size="x-small">layers</v-icon>{{ file.metadata?.totalPlates }}
              </v-chip>
            </div>

            <!-- Actions -->
            <div class="fl-row__actions">
              <v-btn icon size="small" variant="text" color="primary" @click.stop="openQueueDialog(file)">
                <v-icon>add_to_queue</v-icon>
                <v-tooltip activator="parent" location="top">Add to queue</v-tooltip>
              </v-btn>
              <v-btn icon size="small" variant="text" @click.stop="openMoveDialog(file)">
                <v-icon>drive_file_move</v-icon>
                <v-tooltip activator="parent" location="top">Move to folder</v-tooltip>
              </v-btn>
              <v-btn icon size="small" variant="text" @click.stop="openRenameFile(file)">
                <v-icon>drive_file_rename_outline</v-icon>
                <v-tooltip activator="parent" location="top">Rename</v-tooltip>
              </v-btn>
              <v-btn icon size="small" variant="text" color="info" :loading="analyzingFiles.has(file.fileStorageId)" @click.stop="analyzeFile(file)">
                <v-icon>analytics</v-icon>
                <v-tooltip activator="parent" location="top">Trigger analysis</v-tooltip>
              </v-btn>
              <v-btn icon size="small" variant="text" @click.stop="viewFile(file)">
                <v-icon>visibility</v-icon>
                <v-tooltip activator="parent" location="top">View details</v-tooltip>
              </v-btn>
              <v-btn icon size="small" variant="text" color="error" @click.stop="deleteFile(file)">
                <v-icon>delete</v-icon>
                <v-tooltip activator="parent" location="top">Delete file</v-tooltip>
              </v-btn>
            </div>
          </div>
        </div>

        <!-- ─── Pagination ──── -->
        <div v-if="filteredFiles.length > filesPerPage" class="fl-pager">
          <v-pagination
            v-model="filesPage"
            :length="filesPageCount"
            :total-visible="5"
            density="comfortable"
          />
        </div>
      </v-card-text>
    </v-card>

    <FileDetailsDialog
      v-model="detailsDialog"
      :file="selectedFile"
    />

    <QueueFileDialog
      v-model="queueDialog"
      :file="selectedFileForQueue"
    />

    <!-- ─── Create / rename folder dialog ───────────────────── -->
    <v-dialog
      v-model="folderDialog.open"
      max-width="440"
      @keydown.esc="closeFolderDialog()"
    >
      <v-card>
        <v-card-title class="d-flex align-center ga-2 text-subtitle-1">
          <v-icon size="small">
            {{ folderDialog.mode === 'rename' ? 'drive_file_rename_outline' : 'create_new_folder' }}
          </v-icon>
          {{ folderDialog.mode === 'rename' ? 'Rename folder' : 'New folder' }}
        </v-card-title>
        <v-card-text class="pb-2">
          <div
            v-if="folderDialog.mode === 'create' && currentFolderPath"
            class="text-caption text-medium-emphasis mb-2 d-flex align-center ga-1"
          >
            <v-icon size="x-small">folder</v-icon>
            Inside {{ currentFolderPath }}
          </div>
          <v-text-field
            v-model="folderDialog.name"
            :label="folderDialog.mode === 'rename' ? 'New name' : 'Folder name'"
            placeholder="my-folder"
            variant="outlined"
            density="compact"
            autofocus
            :error-messages="folderDialog.error ? [folderDialog.error] : []"
            hide-details="auto"
            @keydown.enter.prevent="submitFolderDialog()"
            @input="folderDialog.error = null"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn
            variant="text"
            :disabled="folderDialog.busy"
            @click="closeFolderDialog()"
          >
            Cancel
          </v-btn>
          <v-btn
            color="primary"
            variant="flat"
            :loading="folderDialog.busy"
            :disabled="!folderDialog.name.trim()"
            @click="submitFolderDialog()"
          >
            {{ folderDialog.mode === 'rename' ? 'Rename' : 'Create' }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- ─── Bulk move dialog ────────────────────────────────── -->
    <v-dialog
      v-model="bulkMoveDialog.open"
      max-width="480"
      @keydown.esc="bulkMoveDialog.open = false"
    >
      <v-card>
        <v-card-title class="d-flex align-center ga-2 text-subtitle-1">
          <v-icon size="small">drive_file_move</v-icon>
          Move {{ selectedCount }} item(s)
        </v-card-title>
        <v-card-text>
          <div class="text-caption text-medium-emphasis mb-2">Destination folder</div>
          <FolderPicker v-model="bulkMoveDialog.targetPath" :folders="allFolderPaths" />
          <div v-if="bulkMoveDialog.error" class="text-caption text-error mt-2">{{ bulkMoveDialog.error }}</div>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" :disabled="bulkMoveDialog.busy" @click="bulkMoveDialog.open = false">
            Cancel
          </v-btn>
          <v-btn
            color="primary"
            variant="flat"
            :loading="bulkMoveDialog.busy"
            @click="submitBulkMove()"
          >
            Move all
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- ─── Move file dialog ────────────────────────────────── -->
    <v-dialog
      v-model="moveDialog.open"
      max-width="480"
      @keydown.esc="moveDialog.open = false"
    >
      <v-card>
        <v-card-title class="d-flex align-center ga-2 text-subtitle-1">
          <v-icon size="small">drive_file_move</v-icon>
          Move file
        </v-card-title>
        <v-card-text>
          <div v-if="moveDialog.file" class="text-body-2 mb-3 text-truncate">
            <v-icon size="small" class="mr-1">description</v-icon>
            {{ displayFileName(moveDialog.file) }}
          </div>
          <div class="text-caption text-medium-emphasis mb-2">Destination folder</div>
          <FolderPicker v-model="moveDialog.targetPath" :folders="allFolderPaths" />
          <div v-if="moveDialog.error" class="text-caption text-error mt-2">{{ moveDialog.error }}</div>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" :disabled="moveDialog.busy" @click="moveDialog.open = false">
            Cancel
          </v-btn>
          <v-btn
            color="primary"
            variant="flat"
            :loading="moveDialog.busy"
            @click="submitMoveDialog()"
          >
            Move
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- ─── Rename file dialog ──────────────────────────────── -->
    <v-dialog
      v-model="renameDialog.open"
      max-width="480"
      @keydown.esc="renameDialog.open = false"
    >
      <v-card>
        <v-card-title class="d-flex align-center ga-2 text-subtitle-1">
          <v-icon size="small">drive_file_rename_outline</v-icon>
          Rename file
        </v-card-title>
        <v-card-text>
          <v-text-field
            v-model="renameDialog.name"
            label="File name"
            :suffix="renameDialog.ext"
            variant="outlined"
            density="compact"
            autofocus
            hide-details="auto"
            :error-messages="renameDialog.error ? [renameDialog.error] : []"
            @keydown.enter="submitRename()"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" :disabled="renameDialog.busy" @click="renameDialog.open = false">
            Cancel
          </v-btn>
          <v-btn
            color="primary"
            variant="flat"
            :loading="renameDialog.busy"
            :disabled="!renameDialog.name.trim()"
            @click="submitRename()"
          >
            Rename
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script lang="ts" setup>
import { ref, computed, onMounted, reactive, watch } from 'vue'
import {
  FileStorageService,
  type FileMetadata,
  type FolderInfo
} from '@/backend/file-storage.service'
import { usePrinterStore } from '@/store/printer.store'
import { useSnackbar } from '@/shared/snackbar.composable'
import { formatFileSize } from '@/utils/file-size.util'
import { displayFileName } from '@/utils/file-name.util'
import { confirm as confirmDialog } from '@/shared/confirm-dialog.composable'
import { formatRelativeTime, formatDuration } from '@/utils/date-time.utils'
import FileDetailsDialog from './FileDetailsDialog.vue'
import QueueFileDialog from './QueueFileDialog.vue'
import FolderPicker from './FolderPicker.vue'

const snackbar = useSnackbar()
const printerStore = usePrinterStore()

const files = ref<FileMetadata[]>([])
const folders = ref<FolderInfo[]>([])
const allFolderPaths = ref<string[]>([])
const currentFolderPath = ref<string | null>(null)
const exportingPath = ref<string | null>(null)
const loading = ref(false)
const searchQuery = ref('')
const detailsDialog = ref(false)
const selectedFile = ref<FileMetadata | null>(null)
const queueDialog = ref(false)
const selectedFileForQueue = ref<FileMetadata | null>(null)
const uploading = ref(false)
const isDragging = ref(false)

const folderDialog = reactive<{
  open: boolean
  mode: 'create' | 'rename'
  name: string
  busy: boolean
  error: string | null
  renameSource: FolderInfo | null
}>({
  open: false,
  mode: 'create',
  name: '',
  busy: false,
  error: null,
  renameSource: null
})

const moveDialog = reactive<{
  open: boolean
  file: FileMetadata | null
  targetPath: string
  busy: boolean
  error: string | null
}>({
  open: false,
  file: null,
  targetPath: '',
  busy: false,
  error: null
})

const renameDialog = reactive<{
  open: boolean
  file: FileMetadata | null
  name: string
  ext: string
  busy: boolean
  error: string | null
}>({
  open: false,
  file: null,
  name: '',
  ext: '',
  busy: false,
  error: null
})

const selected = ref<string[]>([])
const bulkDeleting = ref(false)

const draggedFileId = ref<string | null>(null)
const dragOverFolderPath = ref<string | null>(null)
const isFileDragging = computed(() => draggedFileId.value !== null)
const bulkMoveDialog = reactive<{
  open: boolean
  targetPath: string
  busy: boolean
  error: string | null
}>({
  open: false,
  targetPath: '',
  busy: false,
  error: null,
})
const dragDepth = ref(0)
const uploadProgress = ref<
  Array<{ fileName: string; percent: number; error?: string }>
>([])
const fileInput = ref<HTMLInputElement | null>(null)
const folderInput = ref<HTMLInputElement | null>(null)
const analyzingFiles = ref<Set<string>>(new Set())

// Aggregate upload progress (one bar for the whole batch instead of one per
// file) and a persistent error list so results don't vanish on big uploads.
const uploadDoneCount = computed(() => uploadProgress.value.filter((p) => p.percent === 100).length)
const uploadErrored = computed(() => uploadProgress.value.filter((p) => p.error))
const uploadErroredCount = computed(() => uploadErrored.value.length)
const uploadOkCount = computed(() => uploadProgress.value.filter((p) => p.percent === 100 && !p.error).length)
const currentUploadName = computed(() => uploadProgress.value.find((p) => p.percent < 100)?.fileName ?? '')

// Auto-dismiss the progress card only when everything succeeded; otherwise
// keep the result (with the error list) until the user closes it.
const maybeClearUpload = () => {
  if (uploadProgress.value.every((p) => !p.error)) {
    setTimeout(() => {
      uploadProgress.value = []
    }, 1500)
  }
}

const totalCount = computed(() => files.value.length)

const filteredFiles = computed(() => {
  if (!searchQuery.value) {
    return files.value
  }
  const query = searchQuery.value.toLowerCase()
  return files.value.filter(
    (file) =>
      displayFileName(file).toLowerCase().includes(query) ||
      file.fileName.toLowerCase().includes(query) ||
      file.fileHash.toLowerCase().includes(query) ||
      file.fileStorageId.toLowerCase().includes(query)
  )
})

// ─── File row list: pagination + selection ──────────────────────
const filesPage = ref(1)
const filesPerPage = ref(25)
const filesPageCount = computed(() =>
  Math.max(1, Math.ceil(filteredFiles.value.length / filesPerPage.value))
)
const paginatedFiles = computed(() => {
  const start = (filesPage.value - 1) * filesPerPage.value
  return filteredFiles.value.slice(start, start + filesPerPage.value)
})
watch([filteredFiles, filesPerPage], () => {
  filesPage.value = 1
})

// Selection spans both files (by storage id) and folders (by path).
const selectedFolders = ref<string[]>([])
const isSelected = (id: string) => selected.value.includes(id)
const toggleSelect = (id: string) => {
  const i = selected.value.indexOf(id)
  if (i === -1) selected.value.push(id)
  else selected.value.splice(i, 1)
}
const isFolderSelected = (path: string) => selectedFolders.value.includes(path)
const toggleFolderSelect = (path: string) => {
  const i = selectedFolders.value.indexOf(path)
  if (i === -1) selectedFolders.value.push(path)
  else selectedFolders.value.splice(i, 1)
}

const selectedCount = computed(() => selected.value.length + selectedFolders.value.length)

const allSelected = computed(() => {
  const total = folders.value.length + filteredFiles.value.length
  return (
    total > 0 &&
    selectedFolders.value.length === folders.value.length &&
    filteredFiles.value.every((f) => selected.value.includes(f.fileStorageId))
  )
})
const someSelected = computed(() => selectedCount.value > 0 && !allSelected.value)

const toggleSelectAll = () => {
  if (allSelected.value) {
    clearSelection()
  } else {
    selected.value = filteredFiles.value.map((f) => f.fileStorageId)
    selectedFolders.value = folders.value.map((f) => f.path)
  }
}

const clearSelection = () => {
  selected.value = []
  selectedFolders.value = []
}

// Left accent stripe colour per file format, matching the grid/queue
// format chips (gcode = green, bgcode = blue, 3mf = orange).
const fileFormatAccent = (fileFormat: string): string => {
  switch ((fileFormat || '').toLowerCase()) {
    case 'gcode': return 'rgb(var(--v-theme-success))'
    case 'bgcode': return 'rgb(var(--v-theme-info))'
    case '3mf': return 'rgb(var(--v-theme-warning))'
    default: return 'rgba(var(--v-theme-on-surface), 0.2)'
  }
}

const fileFilamentText = (file: FileMetadata): string => {
  const grams = file.metadata?.filamentUsedGrams as number | number[] | null | undefined
  if (grams == null) return ''
  if (Array.isArray(grams)) {
    return grams.map((v) => (v != null ? v.toFixed(1) : '-')).join(', ') + 'g'
  }
  return grams.toFixed(1) + 'g'
}

onMounted(async () => {
  await Promise.all([loadFiles(), loadFolderTree()])
  await printerStore.loadPrinters()
})

const loadFiles = async () => {
  loading.value = true
  try {
    const response = await FileStorageService.listFiles(currentFolderPath.value)
    files.value = response.files
    folders.value = response.folders
  } catch (error) {
    console.error('Failed to load files:', error)
    snackbar.error('Failed to load files')
  } finally {
    loading.value = false
  }
}

async function loadFolderTree() {
  try {
    const response = await FileStorageService.getFolderTree()
    allFolderPaths.value = response.folders.map(f => f.path)
  } catch (error) {
    console.error('Failed to load folder tree:', error)
  }
}

const folderBreadcrumb = computed(() => {
  if (!currentFolderPath.value) return []
  const segments = currentFolderPath.value.split('/').filter(Boolean)
  const acc: Array<{ path: string; name: string }> = []
  let prefix = ''
  for (const seg of segments) {
    prefix += '/' + seg
    acc.push({ path: prefix, name: seg })
  }
  return acc
})

async function navigateToFolder(path: string | null) {
  currentFolderPath.value = path
  await loadFiles()
}

function navigateToParent() {
  const current = currentFolderPath.value
  if (!current) return
  const parent = current.split('/').slice(0, -1).join('/')
  navigateToFolder(parent || null)
}

async function exportFolder(folder: { path: string; name: string }) {
  exportingPath.value = folder.path
  try {
    await FileStorageService.exportFolderZip(folder.path)
    snackbar.info(`Exported "${folder.name}" as ZIP`)
  } catch (error) {
    console.error(`Failed to export folder ${folder.path}:`, error)
    snackbar.error('Failed to export folder')
  } finally {
    exportingPath.value = null
  }
}

function exportCurrentFolder() {
  if (!currentFolderPath.value) return
  const name = currentFolderPath.value.split('/').filter(Boolean).pop() || 'folder'
  exportFolder({ path: currentFolderPath.value, name })
}

function openCreateFolderDialog() {
  folderDialog.mode = 'create'
  folderDialog.name = ''
  folderDialog.error = null
  folderDialog.renameSource = null
  folderDialog.open = true
}

function openRenameFolder(folder: FolderInfo) {
  folderDialog.mode = 'rename'
  folderDialog.name = folder.name
  folderDialog.error = null
  folderDialog.renameSource = folder
  folderDialog.open = true
}

function closeFolderDialog() {
  folderDialog.open = false
  folderDialog.name = ''
  folderDialog.error = null
  folderDialog.renameSource = null
}

async function submitFolderDialog() {
  const clean = folderDialog.name.trim().replace(/^\/+|\/+$/g, '')
  if (!clean) {
    folderDialog.error = 'Name is required'
    return
  }
  if (clean.includes('/')) {
    folderDialog.error = 'Name cannot contain a slash'
    return
  }

  folderDialog.busy = true
  folderDialog.error = null
  try {
    if (folderDialog.mode === 'create') {
      const base = currentFolderPath.value ?? ''
      const fullPath = `${base.replace(/\/+$/, '')}/${clean}`
      await FileStorageService.createFolder(fullPath)
      snackbar.info(`Folder "${clean}" created`)
    } else if (folderDialog.renameSource) {
      const parent = folderDialog.renameSource.path
        .split('/').slice(0, -1).join('/')
      const newPath = `${parent}/${clean}`
      const result = await FileStorageService.renameFolder(
        folderDialog.renameSource.path,
        newPath
      )
      snackbar.info(
        result.filesUpdated > 0
          ? `Folder renamed (${result.filesUpdated} file(s) moved)`
          : 'Folder renamed'
      )
    }
    await loadFiles()
    await loadFolderTree()
    closeFolderDialog()
  } catch (err: any) {
    folderDialog.error =
      err?.response?.data?.error ||
      err?.message ||
      'Operation failed'
  } finally {
    folderDialog.busy = false
  }
}

async function confirmDeleteFolder(folder: FolderInfo) {
  const ok = await confirmDialog({
    title: `Delete folder "${folder.name}"?`,
    message:
      'The folder, all of its subfolders, and every file inside (including nested ones) will be permanently deleted. This cannot be undone.',
    confirmText: 'Delete everything',
    severity: 'danger',
    icon: 'folder_delete',
  })
  if (!ok) return
  try {
    // Standard filesystem delete: remove the whole subtree — nested subfolders
    // (force) and the file binaries inside them (deleteFiles).
    await FileStorageService.deleteFolder(folder.path, { deleteFiles: true, force: true })
    snackbar.info(`Folder "${folder.name}" deleted`)
    await loadFiles()
    await loadFolderTree()
  } catch (err: any) {
    snackbar.error(
      err?.response?.data?.error || err?.message || 'Failed to delete folder'
    )
  }
}

function openMoveDialog(file: FileMetadata) {
  moveDialog.file = file
  moveDialog.targetPath = file.folderPath ?? ''
  moveDialog.error = null
  moveDialog.open = true
}

async function submitMoveDialog() {
  if (!moveDialog.file) return
  const target = moveDialog.targetPath.trim() || null

  moveDialog.busy = true
  moveDialog.error = null
  try {
    await FileStorageService.moveFileToFolder(moveDialog.file.fileStorageId, target)
    snackbar.info(target ? `Moved to ${target}` : 'Moved to Root')
    moveDialog.open = false
    await loadFiles()
  } catch (err: any) {
    moveDialog.error =
      err?.response?.data?.error || err?.message || 'Move failed'
  } finally {
    moveDialog.busy = false
  }
}

function openRenameFile(file: FileMetadata) {
  const full = displayFileName(file)
  const dot = full.lastIndexOf('.')
  renameDialog.file = file
  renameDialog.ext = dot > 0 ? full.slice(dot) : ''
  renameDialog.name = dot > 0 ? full.slice(0, dot) : full
  renameDialog.error = null
  renameDialog.open = true
}

async function submitRename() {
  if (!renameDialog.file) return
  const base = renameDialog.name.trim()
  if (!base) {
    renameDialog.error = 'A name is required'
    return
  }

  renameDialog.busy = true
  renameDialog.error = null
  try {
    await FileStorageService.renameFile(renameDialog.file.fileStorageId, base + renameDialog.ext)
    snackbar.info('File renamed')
    renameDialog.open = false
    await loadFiles()
  } catch (err: any) {
    renameDialog.error =
      err?.response?.data?.error || err?.message || 'Rename failed'
  } finally {
    renameDialog.busy = false
  }
}

// ── Bulk actions ─────────────────────────────────────────────
async function bulkDeleteSelected() {
  const fileCount = selected.value.length
  const folderCount = selectedFolders.value.length
  const count = fileCount + folderCount
  if (count === 0) return
  const ok = await confirmDialog({
    title: `Delete ${count} item${count === 1 ? '' : 's'}?`,
    message: folderCount > 0
      ? 'The selected files and folders (including everything inside them) will be removed from File Storage.'
      : 'The selected files will be removed from File Storage.',
    hint: 'This cannot be undone.',
    confirmText: `Delete ${count} item${count === 1 ? '' : 's'}`,
    severity: 'danger',
    icon: 'delete',
  })
  if (!ok) return

  bulkDeleting.value = true
  let deleted = 0
  let failed = 0
  try {
    for (const path of selectedFolders.value) {
      try {
        await FileStorageService.deleteFolder(path, { deleteFiles: true, force: true })
        deleted++
      } catch {
        failed++
      }
    }
    for (const id of selected.value) {
      try {
        await FileStorageService.deleteFile(id)
        deleted++
      } catch {
        failed++
      }
    }
    snackbar.info(
      failed > 0
        ? `Deleted ${deleted}, failed ${failed}`
        : `Deleted ${deleted} item(s)`
    )
    clearSelection()
    await loadFiles()
    await loadFolderTree()
  } finally {
    bulkDeleting.value = false
  }
}

function openBulkMoveDialog() {
  bulkMoveDialog.targetPath = currentFolderPath.value ?? ''
  bulkMoveDialog.error = null
  bulkMoveDialog.open = true
}

// Move a single folder via the bulk-move dialog (selects just that folder).
function moveFolderSingle(folder: FolderInfo) {
  selected.value = []
  selectedFolders.value = [folder.path]
  bulkMoveDialog.targetPath = ''
  bulkMoveDialog.error = null
  bulkMoveDialog.open = true
}

// ── Drag & drop files onto folder cards ───────────────────────
function onFileDragStart(file: FileMetadata, ev: DragEvent) {
  draggedFileId.value = file.fileStorageId
  if (ev.dataTransfer) {
    ev.dataTransfer.effectAllowed = 'move'
    // Firefox needs *some* data on the transfer to fire dragstart.
    ev.dataTransfer.setData('text/plain', file.fileStorageId)
  }
}

function onFileDragEnd() {
  draggedFileId.value = null
  dragOverFolderPath.value = null
}

function onFolderDragOver(path: string, ev: DragEvent) {
  if (!draggedFileId.value) return
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'
  dragOverFolderPath.value = path
}

function onFolderDragLeave(path: string) {
  if (dragOverFolderPath.value === path) dragOverFolderPath.value = null
}

async function onFolderDrop(targetPath: string | null) {
  const fileId = draggedFileId.value
  draggedFileId.value = null
  dragOverFolderPath.value = null
  if (!fileId) return

  try {
    await FileStorageService.moveFileToFolder(fileId, targetPath)
    snackbar.info(`Moved to ${targetPath || 'Root'}`)
    await loadFiles()
  } catch (err: any) {
    snackbar.error(
      err?.response?.data?.error || err?.message || 'Move failed'
    )
  }
}

async function submitBulkMove() {
  if (selected.value.length === 0 && selectedFolders.value.length === 0) return
  const target = bulkMoveDialog.targetPath.trim() || null

  bulkMoveDialog.busy = true
  bulkMoveDialog.error = null
  let ok = 0
  let fail = 0
  try {
    // Folders move via renameFolder: the destination is the target folder
    // plus the folder's own name (the backend rewrites all descendant paths
    // and rejects moving a folder into one of its own descendants).
    for (const path of selectedFolders.value) {
      const name = path.split('/').filter(Boolean).pop() || path
      const dest = target ? `${target}/${name}` : `/${name}`
      try {
        await FileStorageService.renameFolder(path, dest)
        ok++
      } catch {
        fail++
      }
    }
    for (const id of selected.value) {
      try {
        await FileStorageService.moveFileToFolder(id, target)
        ok++
      } catch {
        fail++
      }
    }
    snackbar.info(
      fail > 0
        ? `Moved ${ok}, failed ${fail}`
        : `Moved ${ok} item(s) to ${target || 'Root'}`
    )
    bulkMoveDialog.open = false
    clearSelection()
    await loadFiles()
    await loadFolderTree()
  } catch (err: any) {
    bulkMoveDialog.error =
      err?.response?.data?.error || err?.message || 'Bulk move failed'
  } finally {
    bulkMoveDialog.busy = false
  }
}

const viewFile = (file: FileMetadata) => {
  selectedFile.value = file
  detailsDialog.value = true
}

const deleteFile = async (file: FileMetadata) => {
  const ok = await confirmDialog({
    title: `Delete "${displayFileName(file)}"?`,
    message: 'The file will be removed from File Storage.',
    hint: 'This cannot be undone.',
    confirmText: 'Delete file',
    severity: 'danger',
    icon: 'delete',
  })
  if (!ok) return

  try {
    await FileStorageService.deleteFile(file.fileStorageId)
    snackbar.info('File deleted successfully')
    await loadFiles()
  } catch (error) {
    console.error('Failed to delete file:', error)
    snackbar.error('Failed to delete file')
  }
}

const analyzeFile = async (file: FileMetadata) => {
  if (analyzingFiles.value.has(file.fileStorageId)) {
    return
  }

  analyzingFiles.value.add(file.fileStorageId)

  try {
    const result = await FileStorageService.analyzeFile(file.fileStorageId)
    snackbar.info(
      `Analysis complete! Found ${result.thumbnailCount} thumbnail(s)`
    )

    await loadFiles()
  } catch (error) {
    console.error('Failed to analyze file:', error)
    snackbar.error('Failed to analyze file')
  } finally {
    analyzingFiles.value.delete(file.fileStorageId)
  }
}

const handleDragOver = (e: DragEvent) => {
  e.preventDefault()
}

const handleDragEnter = (e: DragEvent) => {
  e.preventDefault()
  dragDepth.value++
  if (dragDepth.value === 1) {
    isDragging.value = true
  }
}

const handleDragLeave = (e: DragEvent) => {
  e.preventDefault()
  dragDepth.value--
  if (dragDepth.value === 0) {
    isDragging.value = false
  }
}

// A file to upload plus its subfolder path *relative to the drop/selection*
// ("" means it lands directly in the current folder). For folder uploads the
// top folder name is part of `dir`, so picking/dropping "EmpresaX" recreates
// "<current>/EmpresaX/...".
type UploadItem = { file: File; dir: string }

const ACCEPTED_EXTENSIONS = ['.gcode', '.bgcode', '.3mf']
function isAcceptedFile(name: string): boolean {
  const lower = name.toLowerCase()
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

// Build the absolute slash-path under the current folder from a relative subdir.
function resolveFolderPath(relativeDir: string): string | null {
  const segments = [
    ...(currentFolderPath.value ? currentFolderPath.value.split('/') : []),
    ...relativeDir.split('/')
  ].filter(Boolean)
  return segments.length ? '/' + segments.join('/') : null
}

// Recursively walk a dropped FileSystemEntry, collecting files with their
// relative subfolder path. Uses the (non-standard but widely supported)
// webkitGetAsEntry / FileSystemDirectoryReader API.
async function readEntry(entry: any, base: string, out: UploadItem[]): Promise<void> {
  if (!entry) return
  if (entry.isFile) {
    const file: File = await new Promise((resolve, reject) => entry.file(resolve, reject))
    out.push({ file, dir: base })
    return
  }
  if (entry.isDirectory) {
    const dirPath = base ? `${base}/${entry.name}` : entry.name
    const reader = entry.createReader()
    const readBatch = (): Promise<any[]> =>
      new Promise((resolve, reject) => reader.readEntries(resolve, reject))
    // readEntries returns at most ~100 entries per call; loop until drained.
    let batch = await readBatch()
    while (batch.length > 0) {
      for (const child of batch) await readEntry(child, dirPath, out)
      batch = await readBatch()
    }
  }
}

const handleDrop = async (e: DragEvent) => {
  e.preventDefault()
  dragDepth.value = 0
  isDragging.value = false

  // Prefer the entry API so dropped *folders* keep their structure; fall back
  // to the flat file list when the browser doesn't expose entries.
  const dtItems = e.dataTransfer?.items ? Array.from(e.dataTransfer.items) : []
  const entries = dtItems
    .map((it) => (typeof (it as any).webkitGetAsEntry === 'function' ? (it as any).webkitGetAsEntry() : null))
    .filter(Boolean)

  if (entries.length > 0) {
    const collected: UploadItem[] = []
    for (const entry of entries) await readEntry(entry, '', collected)
    await uploadItems(collected)
  } else {
    await uploadFiles(Array.from(e.dataTransfer?.files || []))
  }
}

const handleFileSelect = async (e: Event) => {
  const target = e.target as HTMLInputElement
  await uploadFiles(Array.from(target.files || []))
  if (fileInput.value) fileInput.value.value = ''
}

// Folder picker (<input webkitdirectory>): each file carries a
// `webkitRelativePath` like "EmpresaX/sub/part.gcode".
const handleFolderSelect = async (e: Event) => {
  const target = e.target as HTMLInputElement
  const items: UploadItem[] = Array.from(target.files || []).map((file) => {
    const rel = (file as any).webkitRelativePath || file.name
    const parts = rel.split('/')
    parts.pop() // drop the filename, leaving the subfolder path
    return { file, dir: parts.join('/') }
  })
  await uploadItems(items)
  if (folderInput.value) folderInput.value.value = ''
}

// Flat upload (plain multi-file select / drop) → no subfolders.
const uploadFiles = (filesToUpload: File[]) =>
  uploadItems(filesToUpload.map((file) => ({ file, dir: '' })))

// Core bulk upload: create the folder tree, then upload each file into its
// resolved destination folder, reusing the existing progress UI.
const uploadItems = async (items: UploadItem[]) => {
  if (items.length === 0) return

  const accepted = items.filter((it) => isAcceptedFile(it.file.name))
  const skipped = items.length - accepted.length
  if (accepted.length === 0) {
    snackbar.error('No .gcode, .bgcode or .3mf files found in the selection')
    return
  }

  uploading.value = true
  uploadProgress.value = accepted.map((it) => ({
    fileName: it.dir ? `${it.dir}/${it.file.name}` : it.file.name,
    percent: 0
  }))

  // 1) Create every subfolder up-front. createFolder is idempotent and creates
  // missing parents, so creating each leaf path is enough.
  const uniqueDirs = [...new Set(accepted.map((it) => it.dir).filter(Boolean))]
  for (const dir of uniqueDirs) {
    const full = resolveFolderPath(dir)
    if (!full) continue
    try {
      await FileStorageService.createFolder(full)
    } catch (error) {
      console.error(`Failed to create folder ${full}:`, error)
    }
  }

  // 2) Upload each file into its destination folder. A 409 means a file with
  // that name already exists in that folder — collect those separately from
  // genuine failures so we can offer to overwrite them.
  let failures = 0
  const conflicts: Array<{ file: File; folderPath: string | null }> = []
  for (let i = 0; i < accepted.length; i++) {
    const { file, dir } = accepted[i]
    const folderPath = resolveFolderPath(dir)
    try {
      await FileStorageService.uploadFile(file, folderPath)
      uploadProgress.value[i].percent = 100
    } catch (error: any) {
      uploadProgress.value[i].percent = 100
      if (error?.response?.status === 409) {
        uploadProgress.value[i].error = 'Already exists'
        conflicts.push({ file, folderPath })
      } else {
        console.error(`Failed to upload ${file.name}:`, error)
        uploadProgress.value[i].error = 'Failed'
        failures++
      }
    }
  }

  uploading.value = false
  const ok = accepted.length - failures - conflicts.length
  const summary: string[] = []
  if (ok > 0) summary.push(`Uploaded ${ok}`)
  if (conflicts.length > 0) summary.push(`${conflicts.length} already existed`)
  if (failures > 0) summary.push(`${failures} failed`)
  if (summary.length) snackbar.info(summary.join(' · '))
  if (skipped > 0) snackbar.info(`Skipped ${skipped} unsupported file${skipped === 1 ? '' : 's'}`)

  await loadFiles()
  await loadFolderTree()

  // Offer to overwrite the files that were skipped because they already exist.
  if (conflicts.length > 0) {
    const overwrite = await confirmDialog({
      title: `${conflicts.length} file${conflicts.length === 1 ? '' : 's'} already existed`,
      message:
        conflicts.length === 1
          ? 'It was kept as-is to avoid overwriting. Replace it with the version you just selected?'
          : 'They were kept as-is to avoid overwriting. Replace them with the versions you just selected?',
      confirmText: `Overwrite ${conflicts.length}`,
      severity: 'warning',
      icon: 'sync',
    })
    if (overwrite) {
      await overwriteConflicts(conflicts)
      return
    }
  }

  maybeClearUpload()
}

// Replace each conflicting file: delete the existing one, then re-upload the
// new version into the same folder.
const overwriteConflicts = async (
  conflicts: Array<{ file: File; folderPath: string | null }>
) => {
  uploading.value = true
  uploadProgress.value = conflicts.map((c) => ({
    fileName: c.folderPath ? `${c.folderPath}/${c.file.name}` : c.file.name,
    percent: 0,
  }))

  let done = 0
  let failed = 0
  for (let i = 0; i < conflicts.length; i++) {
    const c = conflicts[i]
    try {
      // The backend replaces the existing file atomically: the old one is only
      // removed once the new upload is saved, so a failure here leaves it intact.
      await FileStorageService.uploadFile(c.file, c.folderPath, true)
      uploadProgress.value[i].percent = 100
      done++
    } catch (error) {
      console.error(`Failed to overwrite ${c.file.name}:`, error)
      uploadProgress.value[i].percent = 100
      uploadProgress.value[i].error = 'Failed'
      failed++
    }
  }

  uploading.value = false
  snackbar.info(
    failed > 0 ? `Overwrote ${done}, ${failed} failed` : `Overwrote ${done} file${done === 1 ? '' : 's'}`
  )
  await loadFiles()
  await loadFolderTree()
  maybeClearUpload()
}

const openQueueDialog = (file: FileMetadata) => {
  selectedFileForQueue.value = file
  queueDialog.value = true
}
</script>

<style scoped>
.files-view {
  position: relative;
  min-height: calc(100vh - var(--v-layout-top, 64px));
}

.files-view--dragging::after {
  content: '';
  position: absolute;
  inset: 0;
  background: rgba(var(--v-theme-primary), 0.06);
  border: 2px dashed rgb(var(--v-theme-primary));
  border-radius: 8px;
  pointer-events: none;
  z-index: 1;
}

/* ─── Header ─────────────────────────────────────────────────── */
.files-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}

.files-header__title {
  display: flex;
  align-items: center;
}

.files-header__search {
  flex: 0 1 320px;
  min-width: 200px;
}

/* ─── Breadcrumb ─────────────────────────────────────────────── */
.files-breadcrumb {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px;
  margin-bottom: 12px;
  padding: 4px 8px;
  background: rgba(var(--v-theme-on-surface), 0.03);
  border-radius: 8px;
}

/* ─── Folders, vertical, merged above the file list ──────────── */
.files-fs-list {
  display: flex;
  flex-direction: column;
}

.files-fs-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  cursor: pointer;
  transition: background-color 0.12s ease;
}

.files-fs-row:hover {
  background: rgba(var(--v-theme-primary), 0.06);
}

.files-fs-row--up {
  cursor: pointer;
}

.files-fs-row--drop {
  background: rgba(var(--v-theme-primary), 0.16) !important;
  outline: 2px dashed rgb(var(--v-theme-primary));
  outline-offset: -2px;
}

.files-fs-row__icon {
  color: rgb(var(--v-theme-primary));
  flex-shrink: 0;
}

.files-fs-row__name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
}

.files-fs-row__type {
  flex-shrink: 0;
  width: 110px;
}

.files-fs-row__menu-spacer {
  width: 24px;
  flex-shrink: 0;
}

.files-breadcrumb__drop {
  background: rgba(var(--v-theme-primary), 0.16) !important;
  outline: 2px dashed rgb(var(--v-theme-primary));
  outline-offset: -2px;
}

/* Drag handle in file rows */
.files-row-drag {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: grab;
}

.files-row-drag:active {
  cursor: grabbing;
}

.files-row-drag__handle {
  color: rgba(var(--v-theme-on-surface), 0.25);
  flex-shrink: 0;
  transition: color 0.15s ease;
}

.files-row-drag:hover .files-row-drag__handle {
  color: rgba(var(--v-theme-on-surface), 0.6);
}

.files-folder__menu {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  background: transparent;
  border-radius: 50%;
  cursor: pointer;
  color: rgba(var(--v-theme-on-surface), 0.55);
  transition: background-color 0.15s ease, color 0.15s ease;
}

.files-folder__menu:hover {
  background: rgba(var(--v-theme-on-surface), 0.08);
  color: rgb(var(--v-theme-on-surface));
}

/* ─── Bulk action bar ───────────────────────────────────────── */
.files-bulk-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  background: rgba(var(--v-theme-primary), 0.08);
  border-bottom: 1px solid rgba(var(--v-theme-primary), 0.25);
  position: sticky;
  top: 0;
  z-index: 2;
}

/* ─── Drag overlay ───────────────────────────────────────────── */
.files-drag-overlay {
  position: fixed;
  inset: var(--v-layout-top, 64px) 0 0 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: rgba(var(--v-theme-primary), 0.08);
  backdrop-filter: blur(6px);
  z-index: 10;
  pointer-events: none;
}

/* ─── Upload progress card ───────────────────────────────────── */
.files-upload-progress {
  padding: 12px 16px;
  margin-bottom: 16px;
}

.files-upload-progress__title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
  color: rgba(var(--v-theme-on-surface), 0.85);
}

.files-upload-progress__current {
  margin-top: 6px;
  color: rgba(var(--v-theme-on-surface), 0.6);
}

.files-upload-progress__errors {
  max-height: 180px;
  overflow-y: auto;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.08);
  border-radius: 6px;
}

.files-upload-progress__error {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  font-size: 13px;
  border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.04);
}

.files-upload-progress__error:last-child {
  border-bottom: none;
}

.files-upload-progress__error-tag {
  margin-left: auto;
  flex-shrink: 0;
  color: rgba(var(--v-theme-on-surface), 0.55);
}

/* ─── File rows ──────────────────────────────────────────────── */
.fl-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 16px;
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}

.fl-list {
  display: flex;
  flex-direction: column;
}

.fl-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 12px 6px 16px;
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  transition: background-color 0.12s ease;
}

.fl-row:hover {
  background: rgba(var(--v-theme-primary), 0.04);
}

.fl-row--selected {
  background: rgba(var(--v-theme-primary), 0.08);
}

.fl-row__accent {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 4px;
  background: var(--state-color, rgba(var(--v-theme-on-surface), 0.12));
}

/* Pull the checkbox's wide ripple area back a little — but leave a small gap
   so it doesn't sit flush against the thumbnail/folder icon. */
.fl-row__check {
  flex: 0 0 auto;
  margin-right: 2px;
}

.fl-row__check--spacer {
  display: inline-block;
  width: 28px;
}

.files-fs-row--selected {
  background: rgba(var(--v-theme-primary), 0.08);
}

.fl-row__main {
  flex: 1 1 auto;
  min-width: 0;
  cursor: grab;
}

.fl-row__name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
}

.fl-row__drag {
  color: rgba(var(--v-theme-on-surface), 0.4);
}

.fl-row__sub {
  margin-top: 2px;
  font-size: 12px;
  color: rgba(var(--v-theme-on-surface), 0.55);
}

.fl-row__meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px;
  flex: 0 1 auto;
  margin-left: auto;
  max-width: 380px;
}

/* The chip's leading icon renders as tall as the chip, so it touches the
   top/bottom edge. Shrink the icon below the chip height to give it vertical
   breathing room. */
.fl-row__meta :deep(.v-chip) {
  min-height: 22px;
}

.fl-row__meta :deep(.v-chip .v-icon) {
  font-size: 13px !important;
  width: 13px;
  height: 13px;
}

.fl-row__actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
}

.fl-pager {
  display: flex;
  justify-content: center;
  padding: 8px;
}
</style>
