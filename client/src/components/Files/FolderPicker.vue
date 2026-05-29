<template>
  <div class="folder-picker">
    <v-text-field
      v-model="query"
      placeholder="Filter folders…"
      prepend-inner-icon="search"
      density="compact"
      variant="outlined"
      hide-details
      clearable
      autofocus
      class="mb-2"
    />
    <div class="folder-picker__list">
      <!-- Root is always available -->
      <button
        type="button"
        class="folder-picker__row folder-picker__row--root"
        :class="{ 'folder-picker__row--active': modelValue === '' }"
        @click="emit('update:modelValue', '')"
      >
        <span class="folder-picker__toggle" />
        <v-icon size="small" class="mr-2" :color="modelValue === '' ? 'primary' : undefined">home</v-icon>
        <span>Root</span>
        <v-icon v-if="modelValue === ''" size="small" class="folder-picker__check">check</v-icon>
      </button>

      <!-- Filtered: flat list with full paths -->
      <template v-if="query.trim()">
        <button
          v-for="f in filteredFlat"
          :key="f.path"
          type="button"
          class="folder-picker__row"
          :class="{ 'folder-picker__row--active': modelValue === f.path }"
          @click="emit('update:modelValue', f.path)"
        >
          <span class="folder-picker__toggle" />
          <v-icon size="small" class="mr-2" :color="modelValue === f.path ? 'primary' : undefined">folder</v-icon>
          <span class="text-truncate">{{ f.path }}</span>
          <v-icon v-if="modelValue === f.path" size="small" class="folder-picker__check">check</v-icon>
        </button>
        <div v-if="filteredFlat.length === 0" class="folder-picker__empty text-caption text-medium-emphasis">
          No folders match
        </div>
      </template>

      <!-- Collapsible tree -->
      <template v-else>
        <div
          v-for="row in visibleRows"
          :key="row.path"
          class="folder-picker__row"
          :class="{ 'folder-picker__row--active': modelValue === row.path }"
          :style="{ paddingLeft: 4 + row.depth * 18 + 'px' }"
        >
          <button
            v-if="row.hasChildren"
            type="button"
            class="folder-picker__toggle folder-picker__toggle--btn"
            @click.stop="toggle(row.path)"
          >
            <v-icon size="small">{{ expanded.has(row.path) ? 'expand_more' : 'chevron_right' }}</v-icon>
          </button>
          <span v-else class="folder-picker__toggle" />

          <button type="button" class="folder-picker__select" @click="emit('update:modelValue', row.path)">
            <v-icon size="small" class="mr-2" :color="modelValue === row.path ? 'primary' : undefined">folder</v-icon>
            <span class="text-truncate">{{ row.name }}</span>
            <v-icon v-if="modelValue === row.path" size="small" class="folder-picker__check">check</v-icon>
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

interface TreeNode {
  path: string
  name: string
  children: TreeNode[]
}

const props = defineProps<{ modelValue: string; folders: string[] }>()
const emit = defineEmits<{ 'update:modelValue': [string] }>()

const query = ref('')
const expanded = ref<Set<string>>(new Set())

function toggle(path: string) {
  const next = new Set(expanded.value)
  next.has(path) ? next.delete(path) : next.add(path)
  expanded.value = next
}

// Build a nested tree from the flat list of folder paths.
const tree = computed<TreeNode[]>(() => {
  const byPath = new Map<string, TreeNode>()
  const roots: TreeNode[] = []
  const sorted = [...props.folders].sort((a, b) => a.localeCompare(b))
  for (const path of sorted) {
    const segments = path.split('/').filter(Boolean)
    const node: TreeNode = { path, name: segments[segments.length - 1] || path, children: [] }
    byPath.set(path, node)
    if (segments.length <= 1) {
      roots.push(node)
    } else {
      const parent = byPath.get('/' + segments.slice(0, -1).join('/'))
      if (parent) parent.children.push(node)
      else roots.push(node)
    }
  }
  return roots
})

// Flatten the tree to the rows currently visible (children only shown when
// their parent is expanded).
const visibleRows = computed(() => {
  const out: Array<{ path: string; name: string; depth: number; hasChildren: boolean }> = []
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const n of nodes) {
      out.push({ path: n.path, name: n.name, depth, hasChildren: n.children.length > 0 })
      if (n.children.length && expanded.value.has(n.path)) walk(n.children, depth + 1)
    }
  }
  walk(tree.value, 0)
  return out
})

const filteredFlat = computed(() => {
  const q = query.value.trim().toLowerCase()
  return [...props.folders]
    .sort((a, b) => a.localeCompare(b))
    .filter((p) => p.toLowerCase().includes(q))
    .map((path) => ({ path }))
})
</script>

<style scoped>
.folder-picker__list {
  max-height: 300px;
  overflow-y: auto;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.12);
  border-radius: 8px;
}

.folder-picker__row {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 6px 12px 6px 4px;
  font-size: 14px;
  text-align: left;
  color: rgb(var(--v-theme-on-surface));
  border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.04);
  transition: background-color 0.12s ease;
}

.folder-picker__row:last-child {
  border-bottom: none;
}

.folder-picker__row:hover {
  background: rgba(var(--v-theme-primary), 0.06);
}

.folder-picker__row--active {
  background: rgba(var(--v-theme-primary), 0.14);
  font-weight: 600;
}

/* Chevron toggle / spacer keeps icons aligned whether or not a row has kids */
.folder-picker__toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  border-radius: 6px;
  color: rgba(var(--v-theme-on-surface), 0.6);
}

.folder-picker__toggle--btn:hover {
  background: rgba(var(--v-theme-on-surface), 0.1);
}

/* The label area is the clickable select target, fills the rest of the row */
.folder-picker__select {
  display: flex;
  align-items: center;
  flex: 1 1 auto;
  min-width: 0;
  text-align: left;
  color: inherit;
}

.folder-picker__check {
  margin-left: auto;
  color: rgb(var(--v-theme-primary));
}

.folder-picker__empty {
  padding: 16px;
  text-align: center;
}
</style>
