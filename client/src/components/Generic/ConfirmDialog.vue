<template>
  <v-dialog
    :model-value="confirmState.open"
    max-width="480"
    persistent
    @keydown.esc="cancel"
  >
    <v-card class="confirm-dialog">
      <!-- Severity accent: a 4px tinted stripe at the top reads as
           "this is serious" before the user parses the icon or text.
           Critical for destructive actions like Cancel print where
           the page beneath might already carry a colored tint. -->
      <div
        class="confirm-dialog__stripe"
        :class="`confirm-dialog__stripe--${severityColor}`"
      />
      <v-card-title class="d-flex align-center ga-3 pt-5 pb-2">
        <div
          class="confirm-dialog__iconwrap"
          :class="`confirm-dialog__iconwrap--${severityColor}`"
        >
          <v-icon :color="severityColor" size="28">{{ resolvedIcon }}</v-icon>
        </div>
        <div class="text-h6 text-truncate">{{ confirmState.options.title }}</div>
      </v-card-title>

      <v-card-text class="confirm-dialog__body">
        <template v-if="isArrayMessage">
          <p
            v-for="(p, i) in (confirmState.options.message as string[])"
            :key="i"
            class="text-body-1 mb-2"
          >
            {{ p }}
          </p>
        </template>
        <p v-else class="text-body-1">
          {{ confirmState.options.message }}
        </p>
        <p
          v-if="confirmState.options.hint"
          class="text-caption text-medium-emphasis mt-2"
        >
          {{ confirmState.options.hint }}
        </p>
      </v-card-text>

      <v-card-actions class="px-4 pb-4">
        <v-spacer />
        <v-btn
          variant="text"
          @click="cancel"
        >
          {{ confirmState.options.cancelText }}
        </v-btn>
        <v-btn
          :color="severityColor"
          variant="flat"
          :prepend-icon="resolvedIcon"
          @click="confirm"
        >
          {{ confirmState.options.confirmText }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts" setup>
import { computed } from 'vue'
import { confirmState, resolveConfirm, defaultIconFor } from '@/shared/confirm-dialog.composable'

const severityColor = computed(() => {
  switch (confirmState.options.severity) {
    case 'danger':
      return 'error'
    case 'warning':
      return 'warning'
    default:
      return 'primary'
  }
})

const resolvedIcon = computed(
  () => confirmState.options.icon ?? defaultIconFor(confirmState.options.severity),
)

const isArrayMessage = computed(() => Array.isArray(confirmState.options.message))

function cancel() {
  resolveConfirm(false)
}

function confirm() {
  resolveConfirm(true)
}
</script>

<style scoped>
.confirm-dialog {
  position: relative;
  overflow: hidden;
}

.confirm-dialog__stripe {
  height: 4px;
  width: 100%;
}
.confirm-dialog__stripe--error {
  background: rgb(var(--v-theme-error));
}
.confirm-dialog__stripe--warning {
  background: rgb(var(--v-theme-warning));
}
.confirm-dialog__stripe--primary {
  background: rgb(var(--v-theme-primary));
}

/* Tinted circle behind the icon so it reads as a "badge" instead of a
   loose glyph — gives the dialog the visual weight a destructive
   confirm deserves. */
.confirm-dialog__iconwrap {
  flex-shrink: 0;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.confirm-dialog__iconwrap--error {
  background: rgba(var(--v-theme-error), 0.14);
}
.confirm-dialog__iconwrap--warning {
  background: rgba(var(--v-theme-warning), 0.14);
}
.confirm-dialog__iconwrap--primary {
  background: rgba(var(--v-theme-primary), 0.14);
}

.confirm-dialog__body {
  padding-top: 4px;
  padding-bottom: 0;
  padding-left: 76px;
}
</style>
