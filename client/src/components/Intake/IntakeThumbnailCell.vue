<template>
  <div class="intake-thumb" :class="{ clickable: !!thumbnailUrl }" @click="openViewer">
    <v-img v-if="thumbnailUrl" :src="thumbnailUrl" alt="Preview" class="intake-thumb__img">
      <div class="intake-thumb__overlay">
        <v-icon color="white" size="x-small">zoom_in</v-icon>
      </div>
    </v-img>
    <div v-else-if="isLoading" class="intake-thumb__placeholder">
      <v-progress-circular indeterminate size="20" width="2" color="primary" />
    </div>
    <div v-else class="intake-thumb__placeholder">
      <v-icon size="small" color="grey-darken-1">image_not_supported</v-icon>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref, computed, watch } from 'vue'
import { IntakeService, type IntakeItem } from '@/backend/intake.service'
import { selectBestThumbnail } from '@/queries/file-storage-thumbnail.query'
import { useDialog } from '@/shared/dialog.composable'
import { DialogName } from '@/components/Generic/Dialogs/dialog.constants'

const props = defineProps<{ item: IntakeItem }>()

const thumbnailUrl = ref<string | null>(null)
const isLoading = ref(false)

const thumbnailViewerDialog = useDialog(DialogName.JobThumbnailViewer)

// Pick the best-quality thumbnail for the row preview (closest to ~400px,
// largest as fallback) instead of always index 0.
const previewIndex = computed<number | null>(() => {
  const best = selectBestThumbnail(props.item.thumbnails || [])
  return best?.index ?? null
})

watch(
  () => [props.item.id, previewIndex.value] as const,
  async () => {
    thumbnailUrl.value = null
    if (previewIndex.value == null) return
    isLoading.value = true
    try {
      thumbnailUrl.value = await IntakeService.getThumbnailBase64(props.item.id, previewIndex.value)
    } catch {
      thumbnailUrl.value = null
    } finally {
      isLoading.value = false
    }
  },
  { immediate: true },
)

function openViewer() {
  if (!thumbnailUrl.value || !props.item.thumbnails?.length) return
  thumbnailViewerDialog.openDialog({
    source: 'intake',
    intakeItemId: props.item.id,
    thumbnails: props.item.thumbnails,
  })
}
</script>

<style scoped>
.intake-thumb {
  width: 56px;
  height: 56px;
  border-radius: 8px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: rgba(var(--v-theme-on-surface), 0.04);
  position: relative;
}

.intake-thumb.clickable {
  cursor: pointer;
}

.intake-thumb__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.intake-thumb__overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: rgba(0, 0, 0, 0.4);
  opacity: 0;
  transition: opacity 0.2s;
}

.intake-thumb.clickable:hover .intake-thumb__overlay {
  opacity: 1;
}

.intake-thumb__placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
