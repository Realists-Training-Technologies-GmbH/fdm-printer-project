<template>
  <v-tooltip location="top">
    <template v-slot:activator="{ props: tooltipProps }">
      <v-btn
        v-bind="tooltipProps"
        :disabled="!printer"
        color="secondary"
        rounded
        size="small"
        @click.stop="openPrinter()"
      >
        <v-icon>folder</v-icon>
      </v-btn>
    </template>
    <template v-slot:default>Open printer files</template>
  </v-tooltip>
</template>

<script lang="ts" setup>
import { PrinterDto } from '@/models/printers/printer.model'
import { useRouter } from 'vue-router'

interface Props {
  printer: PrinterDto
}

const props = defineProps<Props>()
const router = useRouter()

// Open the individual printer view (its Print tab shows storage/USB files)
// instead of the old slide-out file-explorer panel.
function openPrinter() {
  if (!props.printer) return
  void router.push(`/printer/${props.printer.id}`)
}
</script>
