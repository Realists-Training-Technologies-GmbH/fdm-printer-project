<template>
  <v-container fluid class="appearance-settings pa-6">
    <div class="settings-page__header mb-4">
      <h1 class="text-h5 font-weight-bold mb-1">Appearance</h1>
      <div class="text-body-2 text-medium-emphasis">
        Customize how PrusaHero looks for your team.
      </div>
    </div>

    <v-card elevation="0" border class="mb-4">
      <v-card-text>
        <div class="d-flex align-center mb-1 ga-2">
          <v-icon size="small">image</v-icon>
          <h3 class="text-subtitle-1 font-weight-bold mb-0">Custom logo</h3>
        </div>
        <div class="text-body-2 text-medium-emphasis mb-4">
          Replace the default PrusaHero logo with your own brand. PNG or SVG,
          recommended square aspect ratio for the navigation rail.
        </div>

        <div v-if="loading" class="d-flex justify-center py-6">
          <v-progress-circular indeterminate size="32" />
        </div>

        <template v-else>
          <div class="appearance__logo-row">
            <div class="appearance__logo-preview">
              <img
                v-if="status?.customLogoEnabled"
                :key="cacheBust"
                :src="logoPreviewUrl"
                alt="Custom logo"
                class="appearance__logo-img"
                @error="onPreviewError"
              />
              <img
                v-else
                :src="defaultLogo"
                alt="Default PrusaHero logo"
                class="appearance__logo-img"
              />
              <v-chip
                v-if="status?.customLogoEnabled"
                color="success"
                size="x-small"
                variant="tonal"
                class="appearance__logo-badge"
              >
                Custom
              </v-chip>
            </div>

            <div class="appearance__logo-info">
              <div v-if="status?.customLogoEnabled" class="text-body-2">
                <div class="font-weight-medium mb-1">Custom logo active</div>
                <div class="text-caption text-medium-emphasis">
                  Format: <strong>{{ status.format?.toUpperCase() }}</strong>
                  · Size: <strong>{{ formatBytes(status.size) }}</strong>
                </div>
                <div
                  v-if="status.uploadedAt"
                  class="text-caption text-medium-emphasis"
                >
                  Uploaded {{ formatRelativeTime(status.uploadedAt) }}
                </div>
              </div>
              <div v-else class="text-body-2">
                <div class="font-weight-medium mb-1">Using default logo</div>
                <div class="text-caption text-medium-emphasis">
                  Upload a PNG or SVG to replace it across the app.
                </div>
              </div>

              <div class="d-flex ga-2 mt-3">
                <input
                  ref="fileInput"
                  type="file"
                  accept=".png,.svg,image/png,image/svg+xml"
                  style="display: none"
                  @change="onFileSelected"
                />
                <v-btn
                  color="primary"
                  variant="flat"
                  size="small"
                  :loading="uploading"
                  prepend-icon="upload"
                  @click="fileInput?.click()"
                >
                  {{ status?.customLogoEnabled ? 'Replace logo' : 'Upload logo' }}
                </v-btn>
                <v-btn
                  v-if="status?.customLogoEnabled"
                  color="error"
                  variant="text"
                  size="small"
                  :loading="deleting"
                  prepend-icon="delete"
                  @click="confirmDelete"
                >
                  Remove
                </v-btn>
              </div>

              <v-alert
                v-if="errorMessage"
                type="error"
                variant="tonal"
                density="compact"
                class="mt-3"
              >
                {{ errorMessage }}
              </v-alert>
            </div>
          </div>
        </template>
      </v-card-text>
    </v-card>

    <v-alert
      type="info"
      variant="tonal"
      density="compact"
      icon="info"
    >
      Logo changes take effect immediately for new page loads. Already-open
      tabs may need a hard refresh (Cmd/Ctrl+Shift+R) to pick up the change.
    </v-alert>
  </v-container>
</template>

<script lang="ts" setup>
import { ref, computed, onMounted } from 'vue'
import { BrandingService, type BrandingLogoStatus } from '@/backend/branding.service'
import { useSnackbar } from '@/shared/snackbar.composable'
import defaultLogo from '@/assets/logo.svg'

const snackbar = useSnackbar()

const status = ref<BrandingLogoStatus | null>(null)
const loading = ref(true)
const uploading = ref(false)
const deleting = ref(false)
const errorMessage = ref<string | null>(null)
const cacheBust = ref(Date.now())
const fileInput = ref<HTMLInputElement | null>(null)
const previewBroken = ref(false)

const logoPreviewUrl = computed(() =>
  previewBroken.value ? defaultLogo : BrandingService.getLogoFileUrl(cacheBust.value)
)

onMounted(async () => {
  await refreshStatus()
})

async function refreshStatus() {
  loading.value = true
  errorMessage.value = null
  try {
    status.value = await BrandingService.getStatus()
    cacheBust.value = Date.now()
    previewBroken.value = false
  } catch (err) {
    errorMessage.value = 'Unable to load branding status'
    console.error(err)
  } finally {
    loading.value = false
  }
}

function onPreviewError() {
  previewBroken.value = true
}

async function onFileSelected(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return

  const ext = file.name.toLowerCase().split('.').pop()
  if (ext !== 'png' && ext !== 'svg') {
    errorMessage.value = 'Logo must be a .png or .svg file'
    target.value = ''
    return
  }
  if (file.size === 0) {
    errorMessage.value = 'Logo file is empty'
    target.value = ''
    return
  }

  uploading.value = true
  errorMessage.value = null
  try {
    status.value = await BrandingService.uploadLogo(file)
    cacheBust.value = Date.now()
    previewBroken.value = false
    snackbar.openInfoMessage({ title: 'Custom logo updated' })
  } catch (err: any) {
    errorMessage.value =
      err?.response?.data?.error || err?.message || 'Failed to upload logo'
  } finally {
    uploading.value = false
    if (target) target.value = ''
  }
}

async function confirmDelete() {
  if (!confirm('Remove the custom logo and restore the default?')) return
  deleting.value = true
  errorMessage.value = null
  try {
    status.value = await BrandingService.deleteLogo()
    cacheBust.value = Date.now()
    snackbar.openInfoMessage({ title: 'Custom logo removed' })
  } catch (err: any) {
    errorMessage.value =
      err?.response?.data?.error || err?.message || 'Failed to remove logo'
  } finally {
    deleting.value = false
  }
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}
</script>

<style scoped>
.appearance__logo-row {
  display: flex;
  align-items: flex-start;
  gap: 24px;
  flex-wrap: wrap;
}

.appearance__logo-preview {
  position: relative;
  flex-shrink: 0;
  width: 96px;
  height: 96px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 12px;
  padding: 12px;
  background: rgba(var(--v-theme-on-surface), 0.02);
}

.appearance__logo-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.appearance__logo-badge {
  position: absolute;
  top: -8px;
  right: -8px;
}

.appearance__logo-info {
  flex: 1 1 240px;
  min-width: 0;
}
</style>
