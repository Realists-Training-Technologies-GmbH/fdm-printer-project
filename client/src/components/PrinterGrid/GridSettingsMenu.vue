<template>
  <v-menu :close-on-content-click="false">
    <template v-slot:activator="{ props }">
      <v-btn
        v-bind="props"
        variant="text"
        size="small"
        icon="settings"
      />
    </template>
    <v-card min-width="280">
      <v-card-title class="text-subtitle-1">
        <v-icon class="mr-2" size="small">settings</v-icon>
        Grid Settings
      </v-card-title>
      <v-card-text>
        <v-checkbox
          v-model="largeTilesModel"
          label="Large tiles"
          density="compact"
          hide-details
          @update:model-value="updateLargeTiles"
        />
        <v-checkbox
          v-model="preferCancelModel"
          label="Show cancel instead of quick stop"
          density="compact"
          hide-details
          class="mt-2"
          @update:model-value="updatePreferCancel"
        />

        <v-divider class="my-3" />

        <div class="text-caption text-medium-emphasis mb-2">
          Browser notifications
        </div>
        <v-checkbox
          v-model="notificationsModel"
          :label="notificationsLabel"
          :disabled="!notifications.isSupported"
          density="compact"
          hide-details
          @update:model-value="updateNotifications"
        />
        <div
          v-if="notificationsBlocked"
          class="text-caption text-medium-emphasis mt-1"
        >
          Permission was denied — re-enable it in your browser settings before
          turning this on.
        </div>

        <v-divider class="my-3" />

        <div class="text-caption text-medium-emphasis mb-2">
          Name Sort Direction
        </div>
        <v-radio-group
          v-model="sortDirectionModel"
          density="compact"
          hide-details
          @update:model-value="updateSortDirection"
        >
          <v-radio
            label="Horizontal (left to right)"
            value="horizontal"
            density="compact"
          />
          <v-radio
            label="Vertical (top to bottom)"
            value="vertical"
            density="compact"
          />
        </v-radio-group>
      </v-card-text>
    </v-card>
  </v-menu>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useSettingsStore } from '@/store/settings.store'
import { useBrowserNotifications } from '@/shared/notifications.composable'
import { useSnackbar } from '@/shared/snackbar.composable'

const settingsStore = useSettingsStore()
const notifications = useBrowserNotifications()
const snackbar = useSnackbar()

const largeTilesModel = ref(settingsStore.largeTiles)
const preferCancelModel = ref(settingsStore.preferCancelOverQuickStop)
const sortDirectionModel = ref(settingsStore.gridNameSortDirection)
const notificationsModel = ref(notifications.enabled.value)

const notificationsBlocked = computed(
  () => notifications.isSupported && notifications.permission.value === 'denied',
)

const notificationsLabel = computed(() => {
  if (!notifications.isSupported) return 'Not supported by this browser'
  if (notifications.permission.value === 'denied') return 'Notify when a print finishes (blocked)'
  return 'Notify when a print finishes'
})

async function updateLargeTiles(value: boolean | null) {
  if (!settingsStore.frontendSettings) return
  await settingsStore.updateFrontendSettings({
    ...settingsStore.frontendSettings,
    largeTiles: value ?? false
  })
}

async function updatePreferCancel(value: boolean | null) {
  if (!settingsStore.frontendSettings) return
  await settingsStore.updateFrontendSettings({
    ...settingsStore.frontendSettings,
    tilePreferCancelOverQuickStop: value ?? false
  })
}

async function updateNotifications(value: boolean | null) {
  // `setEnabled(true)` triggers `Notification.requestPermission()` and
  // only flips the toggle when the browser actually grants — so if the
  // user denies the prompt, we have to roll back the checkbox state.
  const desired = value ?? false
  const accepted = await notifications.setEnabled(desired)
  if (desired && !accepted) {
    notificationsModel.value = false
    snackbar.openInfoMessage({
      title: 'Notifications blocked',
      subtitle: 'Allow notifications in the browser permission prompt to enable this.',
      warning: true,
    })
  }
}

async function updateSortDirection(value: 'horizontal' | 'vertical' | null) {
  if (!settingsStore.frontendSettings || !value) return
  await settingsStore.updateFrontendSettings({
    ...settingsStore.frontendSettings,
    gridNameSortDirection: value
  })
}
</script>
