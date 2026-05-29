<template>
  <v-app-bar
    :color="badge.palette.value ?? undefined"
    elevation="0"
    density="comfortable"
    class="topbar"
  >
    <!-- Brand -->
    <router-link
      to="/dashboard"
      class="topbar__brand d-none d-md-flex"
      aria-label="Home"
    >
      <span class="topbar__brand-light">Prusa</span>
      <span class="topbar__brand-strong">Hero</span>
    </router-link>

    <!-- Dev / env badge -->
    <v-chip
      v-if="badge.chipText.value"
      color="yellow"
      variant="elevated"
      size="x-small"
      class="ml-3 mr-2 flex-shrink-0 text-black font-weight-bold text-uppercase"
    >
      {{ badge.chipText.value }}
    </v-chip>

    <!-- Page title -->
    <div
      v-if="pageTitle"
      class="topbar__title"
    >
      <span class="topbar__title-divider" />
      <span class="text-subtitle-1 font-weight-medium text-truncate">
        {{ pageTitle }}
      </span>
    </div>

    <v-spacer />

    <!-- Action group: status menus -->
    <div class="topbar__actions">
      <PrinterStatusMenu />
      <QueueMenu />
      <PrintJobsMenu />
    </div>

    <v-divider
      v-if="authStore.hasAuthToken && !authStore.isLoginExpired"
      vertical
      class="mx-2 my-3"
    />

    <!-- Account menu -->
    <v-menu
      v-if="authStore.hasAuthToken && !authStore.isLoginExpired"
      :close-on-content-click="false"
      location="bottom right"
      open-on-hover
      transition="slide-y-transition"
    >
      <template #activator="{ props }">
        <v-tooltip location="bottom" :text="username ?? 'Account'">
          <template #activator="{ props: tooltipProps }">
            <v-btn
              variant="text"
              density="comfortable"
              class="topbar__account"
              v-bind="mergeProps(props, tooltipProps)"
            >
              <v-icon class="mr-2">mdi:mdi-account-circle</v-icon>
              <span class="d-none d-lg-inline">{{ username }}</span>
            </v-btn>
          </template>
        </v-tooltip>
      </template>

      <v-list density="compact" min-width="220">
        <v-list-item
          v-for="(item, index) in items"
          :key="index"
          :to="item.path"
          :title="item.title"
          :prepend-icon="item.icon"
          link
        />

        <template v-if="authStore.loginRequired === true">
          <v-divider class="my-1" />
          <v-list-item
            prepend-icon="logout"
            title="Logout"
            link
            @click="logout()"
          />
        </template>

        <template v-if="isDevEnv">
          <v-divider class="my-1" />
          <v-list-item v-if="expiry" disabled prepend-icon="schedule">
            <v-list-item-title class="text-caption">
              Auth expires in {{ expiry }}
            </v-list-item-title>
          </v-list-item>
          <v-list-item disabled prepend-icon="wifi">
            <v-list-item-title class="text-caption font-monospace">
              SocketIO: S{{ socketState.setup ? 1 : 0 }} C{{ socketState.connected ? 1 : 0 }} A{{ socketState.active ? 1 : 0 }}
            </v-list-item-title>
            <v-list-item-subtitle class="text-caption">
              {{ socketState.id }}
            </v-list-item-subtitle>
          </v-list-item>
        </template>
      </v-list>
    </v-menu>

  </v-app-bar>
</template>

<script lang="ts" setup>
import { computed, mergeProps, ref } from "vue";
import { useRouter, useRoute } from 'vue-router'
import { useIntervalFn } from '@vueuse/core'
import PrinterStatusMenu from '@/components/Generic/PrinterStatusMenu.vue'
import QueueMenu from '@/components/Generic/QueueMenu.vue'
import PrintJobsMenu from '@/components/Generic/PrintJobsMenu.vue'
import { useAuthStore } from '@/store/auth.store'
import { useProfileStore } from '@/store/profile.store'
import { routeToLogin } from '@/router/utils'
import { isDevEnv, isProdEnv } from '@/shared/app.constants'
import { socketState } from "@/shared/socketio.service";
import { useDevInstanceBadge } from '@/shared/dev-instance-badge.composable'

const profileStore = useProfileStore()
const authStore = useAuthStore()
const router = useRouter()
const route = useRoute()
const badge = useDevInstanceBadge()

const pageTitles: Record<string, { title: string; subtitle?: string }> = {
  'Print Jobs': { title: 'Print Jobs' },
  'Print Queue': { title: 'Print Queue' },
  'CameraGridView': { title: 'Cameras' },
  'PrintersView': { title: 'Printer List' },
  'PrinterGrid': { title: 'Printer Grid' },
  'Settings': { title: 'Settings' },
  "Files": { title: 'Files' }
}

const pageTitle = computed(() => {
  const routeName = route.name as string
  const routePath = route.path as string

  if (routePath.startsWith('/settings/')) {
    const settingsPageMap: Record<string, string> = {
      '/settings/floors': 'Settings · Floors',
      '/settings/printer': 'Settings · Printer',
      '/settings/emergency-commands': 'Settings · Emergency Commands',
      '/settings/server-protection': 'Settings · Server Protection',
      '/settings/user-management': 'Settings · Users',
      '/settings/account': 'Settings · Account',
      '/settings/appearance': 'Settings · Appearance',
      '/settings/software-upgrade': 'Settings · Software Upgrade',
      '/settings/diagnostics': 'Settings · Diagnostics',
      '/settings/debug-socket': 'Settings · SocketIO Debug',
      '/settings/about': 'Settings · About'
    }
    return settingsPageMap[routePath] || 'Settings'
  }

  return pageTitles[routeName]?.title || ''
})

const items = [
  { title: 'Profile', icon: 'mdi:mdi-account', path: '/settings/account' }
]

const now = ref(Date.now())
if (isDevEnv) {
  useIntervalFn(() => {
    now.value = Date.now()
  }, 1000)
}

const expiry = computed(() => {
  if (isProdEnv) return ''
  if (!authStore.tokenClaims?.exp) return ''
  const diffValue = authStore.tokenClaims.exp - now.value / 1000
  return `${Math.round(diffValue)}s`
})

const username = computed(() => profileStore.username)

async function logout() {
  await authStore.logout(true)
  await routeToLogin(router)
}
</script>

<style scoped>
.topbar :deep(.v-toolbar__content) {
  flex-wrap: nowrap !important;
  padding-right: 8px;
}

.topbar__brand {
  display: flex;
  align-items: center;
  text-decoration: none;
  color: inherit;
  padding: 0 16px;
  height: 100%;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  flex-shrink: 0;
}

.topbar__brand-light {
  font-weight: 300;
  font-size: 1.125rem;
  margin-right: 4px;
}

.topbar__brand-strong {
  font-weight: 700;
  font-size: 1.125rem;
}

.topbar__title {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-left: 8px;
  min-width: 0;
  flex-shrink: 1;
}

.topbar__title-divider {
  display: inline-block;
  width: 2px;
  height: 22px;
  background: rgb(var(--v-theme-primary));
  border-radius: 1px;
  flex-shrink: 0;
}

.topbar__actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.topbar__account {
  text-transform: none;
  letter-spacing: 0;
}
</style>
