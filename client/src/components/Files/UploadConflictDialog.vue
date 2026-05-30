<template>
  <v-dialog v-model="open" max-width="640" scrollable>
    <v-card>
      <v-card-title class="d-flex align-center pa-4">
        <v-icon class="mr-2" color="warning">sync</v-icon>
        <span class="text-h6">
          {{ conflicts.length }} file{{ conflicts.length === 1 ? '' : 's' }} already exist{{ conflicts.length === 1 ? 's' : '' }}
        </span>
        <v-spacer />
        <v-btn icon="close" variant="text" size="small" @click="cancel" />
      </v-card-title>

      <v-divider />

      <!-- Bulk actions -->
      <div class="ucd-bulk px-4 py-2">
        <span class="text-caption text-medium-emphasis">Choose per file, or apply to all:</span>
        <v-spacer />
        <v-btn size="small" variant="text" prepend-icon="sync" @click="setAll('replace')">Replace all</v-btn>
        <v-btn size="small" variant="text" prepend-icon="skip_next" @click="setAll('skip')">Skip all</v-btn>
      </div>

      <v-divider />

      <v-card-text class="pa-0">
        <div v-for="(c, i) in rows" :key="i" class="ucd-row">
          <v-icon size="20" class="mr-2 flex-shrink-0" color="medium-emphasis">description</v-icon>
          <div class="ucd-row__name">
            <div class="text-truncate" :title="c.displayPath">{{ c.fileName }}</div>
            <div v-if="c.folderLabel" class="text-caption text-medium-emphasis text-truncate">
              {{ c.folderLabel }}
            </div>
          </div>
          <v-spacer />
          <v-btn-toggle
            v-model="decisions[i]"
            mandatory
            density="compact"
            variant="outlined"
            divided
            class="ucd-row__toggle flex-shrink-0"
          >
            <v-btn value="replace" size="small">Replace</v-btn>
            <v-btn value="skip" size="small">Skip</v-btn>
          </v-btn-toggle>
        </div>
      </v-card-text>

      <v-divider />

      <v-card-actions class="pa-3">
        <span class="text-caption text-medium-emphasis ml-2">
          {{ replaceCount }} to replace · {{ skipCount }} to skip
        </span>
        <v-spacer />
        <v-btn variant="text" @click="cancel">Cancel</v-btn>
        <v-btn color="primary" variant="elevated" @click="apply">
          {{ replaceCount > 0 ? `Replace ${replaceCount}` : 'Continue' }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts" setup>
import { ref, computed, watch } from 'vue'

export interface UploadConflict {
  file: File
  folderPath: string | null
  displayPath: string
}
export type ConflictDecision = 'replace' | 'skip'

const props = defineProps<{
  modelValue: boolean
  conflicts: UploadConflict[]
}>()
const emit = defineEmits<{
  'update:modelValue': [boolean]
  // Emitted on Apply: the conflicts the user chose to replace (skips dropped).
  resolve: [UploadConflict[]]
  cancel: []
}>()

const open = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})

// One decision per conflict, default to replace (the common intent when
// re-uploading a folder). Reset whenever a fresh conflict set comes in.
const decisions = ref<ConflictDecision[]>([])
watch(
  () => props.conflicts,
  (list) => {
    decisions.value = list.map(() => 'replace')
  },
  { immediate: true },
)

const rows = computed(() =>
  props.conflicts.map((c) => ({
    fileName: c.file.name,
    folderLabel: c.folderPath || '',
    displayPath: c.displayPath,
  })),
)

const replaceCount = computed(() => decisions.value.filter((d) => d === 'replace').length)
const skipCount = computed(() => decisions.value.filter((d) => d === 'skip').length)

function setAll(d: ConflictDecision) {
  decisions.value = props.conflicts.map(() => d)
}

function apply() {
  const chosen = props.conflicts.filter((_, i) => decisions.value[i] === 'replace')
  emit('resolve', chosen)
  open.value = false
}

function cancel() {
  emit('cancel')
  open.value = false
}
</script>

<style scoped>
.ucd-bulk {
  display: flex;
  align-items: center;
  gap: 4px;
}

.ucd-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.06);
}

.ucd-row:last-child {
  border-bottom: none;
}

.ucd-row__name {
  min-width: 0;
  font-size: 14px;
}
</style>
