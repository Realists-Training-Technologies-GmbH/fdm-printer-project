<template>
  <div class="folder-browser">
    <!-- Breadcrumb: shows (and lets you jump to) where you are -->
    <div class="folder-browser__crumbs">
      <button type="button" class="folder-browser__crumb" @click="navigateTo('')">
        <v-icon size="16" class="mr-1">home</v-icon>Root
      </button>
      <template v-for="crumb in crumbs" :key="crumb.path">
        <v-icon size="14" class="folder-browser__sep">chevron_right</v-icon>
        <button
          type="button"
          class="folder-browser__crumb"
          :class="{ 'folder-browser__crumb--current': modelValue === crumb.path }"
          @click="navigateTo(crumb.path)"
        >
          {{ crumb.name }}
        </button>
      </template>
    </div>

    <!-- Quick filter — only when the current folder has enough children to
         warrant it. Matches against the global path so you can also jump
         deep without clicking through. -->
    <v-text-field
      v-if="folders.length > 8"
      v-model="query"
      placeholder="Filter folders…"
      prepend-inner-icon="search"
      density="compact"
      variant="outlined"
      hide-details
      clearable
      class="mb-2"
    />

    <!-- Subfolders of the current folder. Click a folder to go into it. -->
    <div class="folder-browser__list">
      <div v-if="rows.length === 0" class="folder-browser__empty text-caption text-medium-emphasis">
        {{ query.trim() ? 'No folders match.' : 'No subfolders — files will be saved here.' }}
      </div>
      <button
        v-for="row in rows"
        :key="row.path"
        type="button"
        class="folder-browser__row"
        @click="navigateTo(row.path)"
      >
        <v-icon size="20" class="mr-2" color="primary">folder</v-icon>
        <span class="text-truncate">{{ query.trim() ? row.path : row.name }}</span>
        <v-chip v-if="row.childCount > 0" size="x-small" variant="tonal" class="ml-2 flex-shrink-0">
          {{ row.childCount }}
        </v-chip>
        <v-spacer />
        <v-icon size="18" class="folder-browser__enter">chevron_right</v-icon>
      </button>

      <!-- Inline create: a row that turns into an input, in place, creating
           inside the folder you're currently browsing. -->
      <div v-if="creating" class="folder-browser__row folder-browser__create">
        <v-icon size="20" class="mr-2" color="primary">create_new_folder</v-icon>
        <input
          ref="createInput"
          v-model="newName"
          class="folder-browser__input"
          :placeholder="`New folder in ${modelValue === '' ? 'Root' : currentLabel}`"
          @keyup.enter="confirmCreate"
          @keyup.esc="cancelCreate"
        />
        <v-btn
          icon
          size="x-small"
          variant="tonal"
          color="primary"
          :loading="busy"
          :disabled="!newName.trim()"
          @click="confirmCreate"
        >
          <v-icon size="18">check</v-icon>
        </v-btn>
        <v-btn icon size="x-small" variant="text" class="ml-1" @click="cancelCreate">
          <v-icon size="18">close</v-icon>
        </v-btn>
      </div>
      <button
        v-else-if="!query.trim()"
        type="button"
        class="folder-browser__row folder-browser__new"
        @click="startCreate"
      >
        <v-icon size="20" class="mr-2">add</v-icon>
        <span>New folder here</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, nextTick } from 'vue'

const props = defineProps<{ modelValue: string; folders: string[] }>()
const emit = defineEmits<{
  'update:modelValue': [string]
  // Create a folder named `name` inside `parentPath` (the folder currently
  // browsed). `done(createdPath | null)` lets the parent report success so we
  // can navigate into it, or failure so we keep the input open.
  create: [{ parentPath: string; name: string; done: (createdPath: string | null) => void }]
}>()

const query = ref('')
const creating = ref(false)
const newName = ref('')
const busy = ref(false)
const createInput = ref<HTMLInputElement | null>(null)

const currentLabel = computed(() => {
  const segs = props.modelValue.split('/').filter(Boolean)
  return segs[segs.length - 1] || 'Root'
})

function navigateTo(path: string) {
  query.value = ''
  cancelCreate()
  emit('update:modelValue', path)
}

async function startCreate() {
  creating.value = true
  newName.value = ''
  await nextTick()
  createInput.value?.focus()
}

function cancelCreate() {
  creating.value = false
  newName.value = ''
  busy.value = false
}

function confirmCreate() {
  const name = newName.value.trim()
  if (!name || busy.value) return
  busy.value = true
  emit('create', {
    parentPath: props.modelValue,
    name,
    done: (createdPath) => {
      busy.value = false
      if (createdPath) {
        creating.value = false
        newName.value = ''
        navigateTo(createdPath)
      }
    },
  })
}

const crumbs = computed(() => {
  const segs = props.modelValue.split('/').filter(Boolean)
  const out: Array<{ name: string; path: string }> = []
  let acc = ''
  for (const s of segs) {
    acc += `/${s}`
    out.push({ name: s, path: acc })
  }
  return out
})

function childCountOf(path: string): number {
  return props.folders.filter((p) => (p.slice(0, p.lastIndexOf('/')) || '') === path).length
}

// With a query: flat global search across all folders. Otherwise: direct
// children (one level down) of the current folder. Each row carries how many
// subfolders it has so the user sees there's more to drill into.
const rows = computed(() => {
  const q = query.value.trim().toLowerCase()
  const source = q
    ? props.folders.filter((p) => p.toLowerCase().includes(q))
    : props.folders.filter((p) => (p.slice(0, p.lastIndexOf('/')) || '') === props.modelValue)
  return source
    .map((path) => ({
      path,
      name: path.split('/').filter(Boolean).pop() || path,
      childCount: childCountOf(path),
    }))
    .sort((a, b) => (q ? a.path.localeCompare(b.path) : a.name.localeCompare(b.name)))
})
</script>

<style scoped>
.folder-browser__crumbs {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px;
  padding: 6px 8px;
  margin-bottom: 6px;
  border-radius: 8px;
  background: rgba(var(--v-theme-on-surface), 0.04);
}

.folder-browser__crumb {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 13px;
  color: rgba(var(--v-theme-on-surface), 0.75);
  transition: background-color 0.12s ease;
}

.folder-browser__crumb:hover {
  background: rgba(var(--v-theme-primary), 0.1);
}

.folder-browser__crumb--current {
  color: rgb(var(--v-theme-primary));
  font-weight: 600;
}

.folder-browser__sep {
  color: rgba(var(--v-theme-on-surface), 0.4);
}

.folder-browser__list {
  max-height: 260px;
  overflow-y: auto;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.12);
  border-radius: 8px;
}

.folder-browser__row {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 10px 12px;
  font-size: 14px;
  text-align: left;
  color: rgb(var(--v-theme-on-surface));
  border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.04);
  transition: background-color 0.12s ease;
}

.folder-browser__row:last-child {
  border-bottom: none;
}

.folder-browser__row:hover {
  background: rgba(var(--v-theme-primary), 0.06);
}

.folder-browser__enter {
  color: rgba(var(--v-theme-on-surface), 0.4);
}

.folder-browser__empty {
  padding: 20px;
  text-align: center;
}

/* New-folder affordance, sits as the last row of the list */
.folder-browser__new {
  color: rgb(var(--v-theme-primary));
  cursor: pointer;
}

.folder-browser__new:hover {
  background: rgba(var(--v-theme-primary), 0.06);
}

.folder-browser__create {
  gap: 4px;
}

.folder-browser__input {
  flex: 1 1 auto;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  font-size: 14px;
  color: rgb(var(--v-theme-on-surface));
}

.folder-browser__input::placeholder {
  color: rgba(var(--v-theme-on-surface), 0.5);
}
</style>
