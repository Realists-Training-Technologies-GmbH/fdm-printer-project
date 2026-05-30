<template>
  <v-navigation-drawer
    permanent
    rail
    class="nav-rail"
  >
    <router-link
      to="/dashboard"
      class="nav-logo"
      aria-label="Home"
    >
      <v-img
        alt="PrusaHero Logo"
        :src="imgLogo"
        class="nav-logo__img"
        transition="scale-transition"
      />
    </router-link>

    <v-divider />

    <v-list
      density="compact"
      nav
      class="nav-list"
    >
      <v-tooltip
        v-for="([icon, title, path], i) in primaryItems"
        :key="i"
        location="end"
        :text="title"
      >
        <template #activator="{ props }">
          <v-list-item
            v-bind="props"
            :to="path"
            density="comfortable"
            color="primary"
            class="nav-item"
            router-link
          >
            <template #prepend>
              <v-badge
                v-if="path === '/intake' && intakePending > 0"
                :content="intakePending"
                color="primary"
                offset-x="-2"
                offset-y="-2"
              >
                <v-icon>{{ icon }}</v-icon>
              </v-badge>
              <v-icon v-else>{{ icon }}</v-icon>
            </template>
          </v-list-item>
        </template>
      </v-tooltip>
    </v-list>

    <template #append>
      <v-divider />
      <v-list
        density="compact"
        nav
        class="nav-list nav-list--bottom"
      >
        <v-tooltip
          v-for="([icon, title, path], i) in secondaryItems"
          :key="i"
          location="end"
          :text="title"
        >
          <template #activator="{ props }">
            <v-list-item
              v-bind="props"
              :to="path"
              :prepend-icon="icon"
              density="comfortable"
              color="primary"
              class="nav-item"
              router-link
            />
          </template>
        </v-tooltip>
      </v-list>
    </template>
  </v-navigation-drawer>
</template>

<script lang="ts" setup>
import imgLogo from '@/assets/logo.svg'
import { onMounted } from 'vue'
import { useIntakePendingCount, ensureIntakeCountStarted } from '@/shared/intake-count.composable'

const intakePending = useIntakePendingCount()
onMounted(() => ensureIntakeCountStarted())

const primaryItems: Array<[string, string, string]> = [
  ['dashboard', 'Dashboard', '/dashboard'],
  ['view_module', 'Printer Grid', '/printer-grid'],
  ['mdi:mdi-printer', 'Printers', '/printer-list'],
  ['mdi:mdi-camera', 'Cameras', '/cameras'],
  ['mdi:mdi-history', 'Print Jobs', '/jobs'],
  ['mdi:mdi-folder', 'Files', '/files'],
  ['mdi:mdi-tray-arrow-down', 'Intake', '/intake'],
  ['build', 'Maintenance', '/maintenance'],
]

const secondaryItems: Array<[string, string, string]> = [
  ['mdi:mdi-cog', 'Settings', '/settings'],
]
</script>

<style scoped>
.nav-rail :deep(.v-navigation-drawer__content) {
  display: flex;
  flex-direction: column;
}

.nav-logo {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 64px;
  text-decoration: none;
  transition: background-color 0.15s ease;
}

.nav-logo:hover {
  background: rgba(var(--v-theme-on-surface), 0.05);
}

.nav-logo__img {
  width: 40px;
  max-width: 40px;
  max-height: 40px;
}

.nav-list {
  padding: 6px 4px;
}

.nav-list--bottom {
  padding-bottom: 8px;
}

.nav-item {
  margin-bottom: 2px;
  border-radius: 8px;
  transition: background-color 0.15s ease;
}

.nav-item :deep(.v-list-item__prepend > .v-icon) {
  opacity: 0.7;
  transition: opacity 0.15s ease;
}

.nav-item:hover :deep(.v-list-item__prepend > .v-icon) {
  opacity: 1;
}

/* Active state: stronger primary accent */
.nav-item.v-list-item--active {
  background: rgba(var(--v-theme-primary), 0.16);
}

.nav-item.v-list-item--active :deep(.v-list-item__prepend > .v-icon) {
  opacity: 1;
  color: rgb(var(--v-theme-primary));
}

.nav-item.v-list-item--active::before {
  content: '';
  position: absolute;
  left: -4px;
  top: 6px;
  bottom: 6px;
  width: 3px;
  border-radius: 0 2px 2px 0;
  background: rgb(var(--v-theme-primary));
}
</style>
