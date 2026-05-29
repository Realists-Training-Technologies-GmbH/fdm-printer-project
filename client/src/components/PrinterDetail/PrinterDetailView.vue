<template>
  <div v-if="!printer" class="pdv-missing">
    <v-icon size="64" color="medium-emphasis">help_outline</v-icon>
    <h2 class="text-h6 mt-2">Printer not found</h2>
    <p class="text-body-2 text-medium-emphasis">No printer with id {{ printerId }}.</p>
    <v-btn class="mt-3" color="primary" variant="tonal" to="/printer-grid">
      Back to grid
    </v-btn>
  </div>

  <div v-else class="pdv" :class="`pdv--${heroToneClass}`">
    <!-- Sticky hero. Identity, state, and (when printing) the live
         progress strip all in one block — the most important info stays
         on screen even as the user scrolls deep into history.
         Collapses to a 56px compact bar past the scroll threshold so
         the long lists in History/Files/Maintenance don't fight the
         hero for vertical space. -->
    <div
      class="pdv-hero-header"
      :class="{ 'pdv-hero-header--compact': isHeroCompact }"
    >
      <div class="pdv-hero-header__top">
        <v-btn
          icon="arrow_back"
          variant="text"
          size="small"
          @click="router.back()"
        />
        <div class="pdv-hero-header__identity">
          <h1 class="pdv-hero-header__name text-truncate" :title="printer.name">
            {{ printer.name }}
          </h1>
          <div class="pdv-hero-header__meta">
            <v-chip
              :color="stateChipColor"
              size="small"
              variant="elevated"
              density="comfortable"
            >
              <v-icon v-if="stateChipIcon" start size="14">{{ stateChipIcon }}</v-icon>
              {{ stateChipText }}
            </v-chip>
            <span
              v-if="firmwareMessage"
              class="pdv-hero-header__fw text-truncate"
              :title="firmwareMessage"
            >
              <v-icon size="12">chat</v-icon>
              {{ firmwareMessage }}
            </span>
            <span class="pdv-hero-header__service text-medium-emphasis">
              PrusaLink · <a :href="printer.printerURL" target="_blank" rel="noopener">{{ shortPrinterURL }}</a>
            </span>
          </div>
        </div>

        <!-- Top-right action cluster. Two groups separated by a thin
             divider: secondary icons on the left (USB / toggle /
             refresh / maintenance — always visible), primary action
             chips on the right (Pause / Cancel / Jog — only when
             there's an active print). Putting them on one line keeps
             every affordance inside thumb's reach without stacking. -->
        <div class="pdv-hero-header__actions">
          <v-tooltip location="bottom" :text="isOperational ? 'Disconnect' : 'Connect'">
            <template #activator="{ props: tip }">
              <v-btn
                v-bind="tip"
                :disabled="!printer.enabled || !isOnline"
                :color="isOperational ? 'warning' : 'success'"
                variant="text"
                size="small"
                density="comfortable"
                icon
                @click="togglePrinterConnection"
              >
                <v-icon size="20">{{ isOperational ? 'usb_off' : 'usb' }}</v-icon>
              </v-btn>
            </template>
          </v-tooltip>

          <v-tooltip location="bottom" :text="printer.enabled ? 'Disable' : 'Enable'">
            <template #activator="{ props: tip }">
              <v-btn
                v-bind="tip"
                :color="printer.enabled ? undefined : 'success'"
                variant="text"
                size="small"
                density="comfortable"
                icon
                @click="toggleEnabled"
              >
                <v-icon size="20">{{ printer.enabled ? 'toggle_on' : 'toggle_off' }}</v-icon>
              </v-btn>
            </template>
          </v-tooltip>

          <v-tooltip location="bottom" text="Refresh connection">
            <template #activator="{ props: tip }">
              <v-btn
                v-bind="tip"
                variant="text"
                size="small"
                density="comfortable"
                icon
                @click="refreshSocketState"
              >
                <v-icon size="20">refresh</v-icon>
              </v-btn>
            </template>
          </v-tooltip>

          <v-tooltip location="bottom" :text="isUnderMaintenance ? 'End maintenance' : 'Start maintenance'">
            <template #activator="{ props: tip }">
              <v-btn
                v-bind="tip"
                :color="isUnderMaintenance ? 'warning' : undefined"
                variant="text"
                size="small"
                density="comfortable"
                icon
                @click="toggleMaintenance"
              >
                <v-icon size="20">{{ isUnderMaintenance ? 'build_circle' : 'build' }}</v-icon>
              </v-btn>
            </template>
          </v-tooltip>

          <!-- Primary print actions — chips for Pause / Cancel / Jog,
               kept inline with the secondary icons so they're a single
               glance away. v-if conditions match the original block
               (Pause/Resume when printing or paused, Cancel when
               stoppable, Jog whenever there's an active print). -->
          <template v-if="(isPrinting || isPaused) && currentJob?.progress">
            <span class="pdv-hero-header__actions-sep" />
            <v-btn
              v-if="isPrinting || isPaused"
              :disabled="!isOnline"
              :color="isPaused ? 'success' : 'warning'"
              size="x-small"
              variant="flat"
              :prepend-icon="isPaused ? 'play_arrow' : 'pause'"
              :loading="pauseToggleBusy"
              @click="isPaused ? clickResumePrint() : clickPausePrint()"
            >
              {{ isPaused ? 'Resume' : 'Pause' }}
            </v-btn>
            <v-btn
              v-if="isStoppable"
              color="error"
              size="x-small"
              variant="flat"
              prepend-icon="stop"
              :loading="stopBusy"
              @click="clickStopPrint"
            >
              Cancel
            </v-btn>
            <v-btn
              :disabled="!isOnline"
              variant="tonal"
              size="x-small"
              prepend-icon="open_with"
              @click="openControlDialog"
            >
              Jog
            </v-btn>
          </template>
        </div>
      </div>

      <!-- "Now printing" block — only when there's an active print.
           Thumbnail on the left, file/progress/stats/slice info on the
           right. Stays inside the sticky hero so the operator never
           loses sight of what's running while navigating tabs. -->
      <div
        v-if="(isPrinting || isPaused) && currentJob?.progress"
        class="pdv-hero-header__now"
      >
        <div class="pdv-hero-header__thumb">
          <v-img
            v-if="thumbnail"
            :src="'data:image/png;base64,' + thumbnail"
            cover
          />
          <v-icon v-else size="48" color="medium-emphasis">image</v-icon>
        </div>
        <div class="pdv-hero-header__now-body">
          <div class="pdv-hero-header__progress-row">
            <span class="pdv-hero-header__file text-truncate" :title="currentFileName ?? ''">
              {{ currentFileName ?? '—' }}
            </span>
            <span class="pdv-hero-header__percent">
              {{ progressPercent }}%
            </span>
          </div>
          <v-progress-linear
            :model-value="currentJob.progress.completion ?? 0"
            :color="isPaused ? 'warning' : 'success'"
            height="6"
            rounded
          />
          <!-- Stats line: temps + elapsed + remaining + ETA clock. -->
          <div class="pdv-stats">
            <span v-if="toolTempStr" class="pdv-stats__item" :title="`Tool: ${toolTempStr}`">
              <v-icon size="14">whatshot</v-icon> {{ toolTempStr }}
            </span>
            <span v-if="bedTempStr" class="pdv-stats__item" :title="`Bed: ${bedTempStr}`">
              <v-icon size="14">bed</v-icon> {{ bedTempStr }}
            </span>
            <span v-if="elapsedFormatted" class="pdv-stats__item" title="Time elapsed">
              <v-icon size="14">history</v-icon> {{ elapsedFormatted }}
            </span>
            <span v-if="timeRemainingFormatted" class="pdv-stats__item" title="Time remaining">
              <v-icon size="14">schedule</v-icon> {{ timeRemainingFormatted }}
            </span>
            <span v-if="etaClockFormatted" class="pdv-stats__item" title="Estimated finish">
              <v-icon size="14">check_circle</v-icon> done {{ etaClockFormatted }}
            </span>
          </div>
          <!-- Slice metadata row (filament, layer height, model). Only
               renders when the thumbnail-record query returned the
               enriched `job` block; legacy rows without it still get
               the temp/time line above. -->
          <div v-if="hasSliceMeta" class="pdv-slice">
            <span v-if="currentFilamentSummary" class="pdv-slice__item" title="Filament">
              <v-icon size="14">fitness_center</v-icon> {{ currentFilamentSummary }}
            </span>
            <span v-if="currentSliceMetadata?.layerHeight" class="pdv-slice__item" title="Layer height">
              <v-icon size="14">layers</v-icon> {{ currentSliceMetadata.layerHeight }} mm
            </span>
            <span v-if="currentSliceMetadata?.printerModel" class="pdv-slice__item" title="Sliced for">
              <v-icon size="14">precision_manufacturing</v-icon> {{ currentSliceMetadata.printerModel }}
            </span>
          </div>
        </div>

      </div>

      <!-- Compact-mode summary — single short line shown only when the
           hero is collapsed and a print is active. Keeps the file
           name, percent, remaining time and a Pause/Cancel within
           thumb's reach without restoring the full hero. -->
      <div
        v-if="isHeroCompact && (isPrinting || isPaused) && currentJob?.progress"
        class="pdv-hero-header__compact-row"
      >
        <span class="pdv-hero-header__compact-file text-truncate" :title="currentFileName ?? ''">
          {{ currentFileName ?? '—' }}
        </span>
        <span class="pdv-hero-header__compact-pct">{{ progressPercent }}%</span>
        <span v-if="timeRemainingFormatted" class="pdv-hero-header__compact-eta">
          · {{ timeRemainingFormatted }}
        </span>
        <v-spacer />
        <v-btn
          v-if="isPrinting || isPaused"
          :disabled="!isOnline"
          :color="isPaused ? 'success' : 'warning'"
          size="x-small"
          variant="tonal"
          :prepend-icon="isPaused ? 'play_arrow' : 'pause'"
          :loading="pauseToggleBusy"
          @click="isPaused ? clickResumePrint() : clickPausePrint()"
        >
          {{ isPaused ? 'Resume' : 'Pause' }}
        </v-btn>
        <v-btn
          v-if="isStoppable"
          color="error"
          size="x-small"
          variant="tonal"
          prepend-icon="stop"
          :loading="stopBusy"
          @click="clickStopPrint"
        >
          Cancel
        </v-btn>
      </div>

      <!-- Thin progress at the very bottom of the hero. Always visible
           when a print is active so even the compact-mode view shows
           how far along it is without taking extra height. -->
      <v-progress-linear
        v-if="(isPrinting || isPaused) && currentJob?.progress"
        :model-value="currentJob.progress.completion ?? 0"
        :color="isPaused ? 'warning' : 'success'"
        height="3"
        class="pdv-hero-header__progress-bottom"
      />
    </div>

    <!-- Attention banner — same priority order the side nav uses. -->
    <v-alert
      v-if="printerAttention.needsAttention"
      :type="attentionAlertType"
      :icon="printerAttention.icon"
      variant="tonal"
      density="compact"
      class="pdv-attention"
    >
      <div class="font-weight-bold">{{ printerAttention.title }}</div>
      <div class="text-body-2">{{ printerAttention.message }}</div>
      <div
        v-if="printerAttention.hint"
        class="text-caption text-medium-emphasis mt-1"
      >
        {{ printerAttention.hint }}
      </div>
    </v-alert>

    <v-tabs v-model="tab" class="pdv-tabs">
      <v-tab value="overview">Print</v-tab>
      <v-tab value="history">History</v-tab>
      <v-tab value="maintenance">Maintenance</v-tab>
      <v-tab v-if="cameras.length > 0" value="cameras">
        Cameras
        <v-chip
          v-if="cameras.length > 1"
          size="x-small"
          class="ml-1"
          density="comfortable"
        >
          {{ cameras.length }}
        </v-chip>
      </v-tab>
      <v-tab value="settings">Settings</v-tab>
    </v-tabs>

    <v-tabs-window v-model="tab" class="pdv-window">
      <!-- ========== PRINT (tab key stays `overview` so existing URL
           query strings — e.g. ?tab=overview — keep working).
           Two-column layout: Queue on the left, Storage source on the
           right (sub-tabbed Storage / Internal Storage). ========== -->
      <v-tabs-window-item value="overview">
        <div class="pdv-content">
          <v-row dense>
          <v-col cols="12" md="6">
          <!-- SECTION: Queue. "Next up" hero gets the visual weight,
               tail items list compactly below. -->
          <section class="pdv-section">
            <header class="pdv-section__header">
              <span class="pdv-section__label">Queue</span>
              <span
                v-if="queue.length > 0"
                class="pdv-section__hint"
              >{{ queue.length }} job{{ queue.length === 1 ? '' : 's' }}</span>
              <v-spacer />
              <!-- "Send to print" lives on the next-up hero card below,
                   so a second "Process next" button in the section
                   header was redundant. -->
              <v-btn
                icon
                variant="text"
                size="x-small"
                density="comfortable"
                title="Refresh queue"
                @click="loadQueue"
              >
                <v-icon size="16">refresh</v-icon>
              </v-btn>
              <v-btn
                v-if="queue.length > 0"
                icon
                variant="text"
                size="x-small"
                density="comfortable"
                title="Clear queue"
                @click="clearQueue"
              >
                <v-icon size="16" color="error">delete_sweep</v-icon>
              </v-btn>
            </header>
            <v-card class="pdv-card" variant="outlined">
              <v-card-text>
                <div v-if="queueLoading" class="text-center">
                  <v-progress-circular indeterminate size="20" width="2" />
                </div>
                <div v-else-if="queue.length === 0" class="pdv-empty">
                  <v-icon size="32" color="medium-emphasis">inbox</v-icon>
                  <p class="text-body-2 text-medium-emphasis mt-2">
                    Queue is empty. Add jobs from the global Print Jobs view,
                    or queue files directly from the Files tab.
                  </p>
                </div>
                <template v-else>
                  <!-- "Next up" hero — the head of the queue gets a richer
                       card with a thumbnail, slice metadata, and a
                       direct "Send to print" button so the operator
                       doesn't have to scan back up to the toolbar to
                       dispatch. -->
                  <article class="pdv-hero" :class="{ 'pdv-hero--starting': queue[0].status === 'STARTING' }">
                    <!-- Top row: label + remove. The X gets pinned to
                         the upper-right of the hero so it has a
                         consistent corner regardless of how the
                         filename wraps below. -->
                    <div class="pdv-hero__top">
                      <div class="pdv-hero__label">
                        <v-icon size="x-small">north_east</v-icon>
                        Next up
                      </div>
                      <v-btn
                        size="x-small"
                        variant="text"
                        icon
                        title="Remove from queue"
                        :loading="removingQueueId === queue[0].id"
                        @click="removeFromQueue(queue[0])"
                      >
                        <v-icon size="16">close</v-icon>
                      </v-btn>
                    </div>

                    <!-- Body: thumbnail + identity. Filename is free
                         to wrap to any number of lines because the
                         operator needs to confirm the full file before
                         dispatching. Stats and chip live in a kicker
                         row above the name so they don't compete. -->
                    <div class="pdv-hero__body">
                      <div class="pdv-hero__thumb">
                        <FileThumbnailCell
                          v-if="queue[0].fileStorageId"
                          :file-storage-id="queue[0].fileStorageId"
                          :thumbnails="(queue[0].thumbnails as any) || []"
                        />
                        <v-icon v-else size="44" color="medium-emphasis">
                          insert_drive_file
                        </v-icon>
                      </div>
                      <div class="pdv-hero__info">
                        <div class="pdv-hero__kicker">
                          <v-chip
                            v-if="queue[0].fileFormat"
                            size="x-small"
                            variant="tonal"
                            :color="storageFormatChipColor(queue[0].fileFormat)"
                            density="comfortable"
                          >
                            {{ queue[0].fileFormat.toUpperCase() }}
                          </v-chip>
                          <v-chip
                            v-if="queue[0].status === 'STARTING'"
                            size="x-small"
                            color="primary"
                            variant="tonal"
                            density="comfortable"
                          >
                            Transferring…
                          </v-chip>
                          <span
                            v-if="queue[0].fileSize"
                            class="text-caption text-medium-emphasis"
                          >
                            {{ formatHeroFileSize(queue[0].fileSize) }}
                          </span>
                        </div>
                        <div
                          class="pdv-hero__name"
                          :title="displayQueueName(queue[0])"
                        >
                          {{ displayQueueName(queue[0]) }}
                        </div>
                        <div class="pdv-hero__stats">
                          <div v-if="queue[0].estimatedTimeSeconds" class="pdv-hero__stat">
                            <v-icon size="x-small">schedule</v-icon>
                            ~{{ formatQueueDuration(queue[0].estimatedTimeSeconds) }}
                          </div>
                          <div v-if="formatFilamentGramsHero(queue[0].filamentGrams)" class="pdv-hero__stat">
                            <v-icon size="x-small">fitness_center</v-icon>
                            {{ formatFilamentGramsHero(queue[0].filamentGrams) }}
                          </div>
                          <div v-if="queue[0].filamentType" class="pdv-hero__stat">
                            <v-icon size="x-small">science</v-icon>
                            {{ queue[0].filamentType }}
                          </div>
                        </div>
                      </div>
                    </div>

                    <!-- Action bar lives on its own row at the bottom
                         of the hero. Frees the body to use the full
                         card width for the filename. -->
                    <div class="pdv-hero__actionbar">
                      <v-btn
                        size="small"
                        variant="flat"
                        color="success"
                        prepend-icon="play_arrow"
                        :disabled="!isOnline || !isOperational || queueProcessingNext || queue[0].status === 'STARTING'"
                        :loading="queueProcessingNext"
                        @click="processNextInQueue"
                      >
                        Send to print
                      </v-btn>
                    </div>
                  </article>

                  <!-- Tail of the queue. Each row mirrors the storage
                       file rows: thumbnail, format chip, slice stats —
                       so the operator can scan what's coming next
                       without expanding anything. Position labels
                       start at 2 since the hero above is position 1. -->
                  <ol v-if="queue.length > 1" class="pdv-queue-list">
                    <li
                      v-for="(job, idx) in queue.slice(1)"
                      :key="job.id"
                      class="pdv-queue-row"
                    >
                      <span class="pdv-queue-row__pos">{{ idx + 2 }}</span>
                      <div class="pdv-queue-row__thumb">
                        <FileThumbnailCell
                          v-if="job.fileStorageId"
                          :file-storage-id="job.fileStorageId"
                          :thumbnails="(job.thumbnails as any) || []"
                        />
                        <v-icon v-else size="18" color="medium-emphasis">
                          insert_drive_file
                        </v-icon>
                      </div>
                      <div class="pdv-queue-row__body">
                        <div class="pdv-queue-row__titlerow">
                          <span
                            class="pdv-queue-row__name text-truncate"
                            :title="displayQueueName(job)"
                          >
                            {{ displayQueueName(job) }}
                          </span>
                          <v-chip
                            v-if="job.fileFormat"
                            size="x-small"
                            variant="tonal"
                            :color="storageFormatChipColor(job.fileFormat)"
                            density="comfortable"
                            class="pdv-queue-row__chip"
                          >
                            {{ job.fileFormat.toUpperCase() }}
                          </v-chip>
                        </div>
                        <div
                          v-if="job.estimatedTimeSeconds || formatFilamentGramsHero(job.filamentGrams) || job.filamentType"
                          class="pdv-queue-row__meta"
                        >
                          <span v-if="job.estimatedTimeSeconds">
                            <v-icon size="11">schedule</v-icon>
                            ~{{ formatQueueDuration(job.estimatedTimeSeconds) }}
                          </span>
                          <span v-if="formatFilamentGramsHero(job.filamentGrams)">
                            · <v-icon size="11">fitness_center</v-icon>
                            {{ formatFilamentGramsHero(job.filamentGrams) }}
                          </span>
                          <span v-if="job.filamentType" class="text-uppercase">
                            · {{ job.filamentType }}
                          </span>
                        </div>
                      </div>
                      <v-btn
                        size="x-small"
                        variant="text"
                        icon
                        title="Remove from queue"
                        :loading="removingQueueId === job.id"
                        @click="removeFromQueue(job)"
                      >
                        <v-icon size="14">close</v-icon>
                      </v-btn>
                    </li>
                  </ol>
                </template>
              </v-card-text>
            </v-card>
          </section>
          </v-col>

          <v-col cols="12" md="6">
          <!-- Right column: Storage sources. Sub-tabs for Storage
               (file-storage, default) and Internal Storage (printer USB).
               Switching between them swaps the body without losing
               toolbar / search state on either side. -->
          <section class="pdv-section">
            <header class="pdv-section__header">
              <v-tabs
                v-model="storageTab"
                density="compact"
                color="primary"
                hide-slider
                class="pdv-substabs"
              >
                <v-tab value="storage">Storage</v-tab>
                <v-tab value="internal">Internal Storage</v-tab>
              </v-tabs>
            </header>

            <v-tabs-window v-model="storageTab">

              <!-- ── Storage (file-storage) ── -->
              <v-tabs-window-item value="storage">
                <v-card variant="outlined" class="pdv-card">
                  <v-card-title class="d-flex align-center flex-wrap py-2" style="gap: 8px;">
                    <span
                      v-if="storageCount > 0"
                      class="text-caption text-medium-emphasis"
                    >{{ storageCount }} item{{ storageCount === 1 ? '' : 's' }}</span>
                    <v-spacer />
                    <v-text-field
                      v-model="storageSearch"
                      prepend-inner-icon="search"
                      placeholder="Filter…"
                      density="compact"
                      hide-details
                      clearable
                      style="max-width: 200px;"
                    />
                    <!-- Sort menu. "Date" defaults to newest-first which
                         matches what an operator usually wants — the file
                         they just uploaded. Size / time sort largest
                         first; name is alphabetical. -->
                    <v-menu location="bottom end">
                      <template #activator="{ props: ap }">
                        <v-btn
                          v-bind="ap"
                          icon
                          variant="text"
                          size="x-small"
                          density="comfortable"
                          title="Sort"
                        >
                          <v-icon size="16">sort</v-icon>
                        </v-btn>
                      </template>
                      <v-list density="compact" min-width="200">
                        <v-list-subheader>Sort by</v-list-subheader>
                        <v-list-item
                          v-for="opt in storageSortOptions"
                          :key="opt.value"
                          :active="storageSortBy === opt.value"
                          @click="storageSortBy = opt.value"
                        >
                          <template #prepend>
                            <v-icon size="16">{{ opt.icon }}</v-icon>
                          </template>
                          <v-list-item-title>{{ opt.label }}</v-list-item-title>
                          <template #append>
                            <v-icon
                              v-if="storageSortBy === opt.value"
                              size="14"
                              color="primary"
                            >check</v-icon>
                          </template>
                        </v-list-item>
                        <v-divider />
                        <v-list-subheader>Filter</v-list-subheader>
                        <v-list-item
                          @click="onlyCompatibleStorage = !onlyCompatibleStorage"
                        >
                          <template #prepend>
                            <v-icon size="16">{{ onlyCompatibleStorage ? 'check_box' : 'check_box_outline_blank' }}</v-icon>
                          </template>
                          <v-list-item-title>Only compatible</v-list-item-title>
                          <v-list-item-subtitle class="text-caption">
                            Hide files this printer can't run
                          </v-list-item-subtitle>
                        </v-list-item>
                      </v-list>
                    </v-menu>
                    <v-btn
                      icon
                      variant="text"
                      size="x-small"
                      density="comfortable"
                      title="Refresh"
                      @click="loadStorage"
                    >
                      <v-icon size="16">refresh</v-icon>
                    </v-btn>
                  </v-card-title>
                  <v-divider />
                  <v-card-text>
                <!-- Breadcrumb -->
                <div class="mb-2 text-body-2 text-medium-emphasis pdv-files-crumbs">
                  <a
                    href="#"
                    class="pdv-crumb pdv-crumb--home"
                    title="Root"
                    @click.prevent="navigateStorageTo(null)"
                  >
                    <v-icon size="16">home</v-icon>
                  </a>
                  <template v-for="(seg, i) in storageBreadcrumb" :key="i">
                    <span class="mx-1">/</span>
                    <a
                      href="#"
                      class="pdv-crumb"
                      @click.prevent="navigateStorageTo(storageBreadcrumb.slice(0, i + 1).join('/'))"
                    >{{ seg }}</a>
                  </template>
                </div>

                <!-- Hidden-by-compat hint. When the printer-compat
                     mask is on AND we know some files were dropped,
                     show how many and offer an inline toggle so the
                     operator isn't left wondering where files went. -->
                <div
                  v-if="storageHiddenByCompatCount > 0 && onlyCompatibleStorage"
                  class="pdv-storage-hint"
                >
                  <v-icon size="14">filter_alt</v-icon>
                  Hiding {{ storageHiddenByCompatCount }} file{{ storageHiddenByCompatCount === 1 ? '' : 's' }} this printer can't run.
                  <a href="#" @click.prevent="onlyCompatibleStorage = false">Show all</a>
                </div>

                <div v-if="storageLoading" class="pdv-empty">
                  <v-progress-circular indeterminate size="20" width="2" />
                </div>
                <div
                  v-else-if="filteredStorageFolders.length === 0 && filteredStorageFiles.length === 0"
                  class="pdv-empty"
                >
                  <v-icon size="40" color="medium-emphasis">folder_off</v-icon>
                  <p class="text-body-2 text-medium-emphasis mt-2">
                    <template v-if="storageSearch">No matches.</template>
                    <template v-else-if="storageHiddenByCompatCount > 0 && onlyCompatibleStorage">
                      No files compatible with this printer in this folder.
                      <a href="#" class="pdv-crumb" @click.prevent="onlyCompatibleStorage = false">Show all</a>
                    </template>
                    <template v-else>No files in storage here.</template>
                  </p>
                </div>
                <div v-else class="pdv-storage-list">
                  <button
                    v-if="storagePath && !storageSearch"
                    type="button"
                    class="pdv-storage-row pdv-storage-row--up"
                    @click="navigateStorageTo(storageParentPath)"
                  >
                    <v-icon size="20" class="pdv-storage-row__leadicon">arrow_upward</v-icon>
                    <span class="pdv-storage-row__name">..</span>
                  </button>

                  <button
                    v-for="folder in filteredStorageFolders"
                    :key="`sf:${folder.path}`"
                    type="button"
                    class="pdv-storage-row pdv-storage-row--folder"
                    @click="navigateStorageTo(folder.path)"
                  >
                    <v-icon size="22" class="pdv-storage-row__leadicon">folder</v-icon>
                    <div class="pdv-storage-row__body">
                      <div class="pdv-storage-row__title text-truncate" :title="folder.name">
                        {{ folder.name }}
                      </div>
                      <div class="pdv-storage-row__meta">
                        <span>Folder</span>
                        <span v-if="folder.createdAt" class="text-medium-emphasis">
                          · created {{ formatRelativeDate(folder.createdAt) }}
                        </span>
                      </div>
                    </div>
                  </button>

                  <button
                    v-for="f in filteredStorageFiles"
                    :key="`sff:${f.fileStorageId}`"
                    type="button"
                    class="pdv-storage-row pdv-storage-row--file"
                    @click="openStorageDetails(f)"
                  >
                    <!-- Thumbnail behaves like the rest of the row:
                         clicking opens the file-details dialog. The
                         underlying FileThumbnailCell's own click is
                         suppressed (pointer-events: none on the inner
                         layer) so we don't open the global thumbnail
                         viewer at the same time. -->
                    <div class="pdv-storage-row__thumb">
                      <FileThumbnailCell
                        :file-storage-id="f.fileStorageId"
                        :thumbnails="(f.thumbnails as any) || []"
                      />
                    </div>
                    <div class="pdv-storage-row__body">
                      <div class="pdv-storage-row__titlerow">
                        <span class="pdv-storage-row__title text-truncate" :title="displayFileName(f)">
                          {{ displayFileName(f) }}
                        </span>
                        <v-chip
                          v-if="f.fileFormat"
                          size="x-small"
                          variant="tonal"
                          :color="storageFormatChipColor(f.fileFormat)"
                          density="comfortable"
                          class="pdv-storage-row__chip"
                        >
                          {{ f.fileFormat.toUpperCase() }}
                        </v-chip>
                      </div>
                      <!-- Primary metadata line — size, time, weight. -->
                      <div class="pdv-storage-row__meta">
                        <span v-if="formatStorageSize(f.fileSize)">
                          {{ formatStorageSize(f.fileSize) }}
                        </span>
                        <span v-if="f.metadata?.gcodePrintTimeSeconds">
                          · <v-icon size="11" class="pdv-storage-row__metaicon">schedule</v-icon>
                          ~{{ formatQueueDuration(f.metadata.gcodePrintTimeSeconds) }}
                        </span>
                        <span v-if="f.metadata?.filamentUsedGrams">
                          · <v-icon size="11" class="pdv-storage-row__metaicon">fitness_center</v-icon>
                          {{ Math.round(f.metadata.filamentUsedGrams) }} g
                        </span>
                        <span v-if="f.metadata?.filamentType" class="text-uppercase">
                          · {{ f.metadata.filamentType }}
                        </span>
                      </div>
                      <!-- Secondary metadata line — slice profile + target.
                           Each fragment is conditional so we collapse to
                           one line when there's nothing extra to say. -->
                      <div
                        v-if="
                          f.metadata?.layerHeight ||
                          f.metadata?.nozzleDiameterMm ||
                          f.metadata?.totalLayers ||
                          f.metadata?.printerModel
                        "
                        class="pdv-storage-row__meta pdv-storage-row__meta--dim"
                      >
                        <span v-if="f.metadata.layerHeight">
                          <v-icon size="11" class="pdv-storage-row__metaicon">layers</v-icon>
                          {{ f.metadata.layerHeight }} mm
                        </span>
                        <span v-if="f.metadata.nozzleDiameterMm">
                          · <v-icon size="11" class="pdv-storage-row__metaicon">water_drop</v-icon>
                          {{ f.metadata.nozzleDiameterMm }} mm
                        </span>
                        <span v-if="f.metadata.totalLayers">
                          · {{ f.metadata.totalLayers }} layers
                        </span>
                        <span v-if="f.metadata.printerModel">
                          · <v-icon size="11" class="pdv-storage-row__metaicon">precision_manufacturing</v-icon>
                          {{ f.metadata.printerModel }}
                        </span>
                      </div>
                    </div>
                    <!-- Per-row actions. Delete lives in the details
                         dialog only — keeps the row scannable and the
                         destructive action behind one more click. -->
                    <div class="pdv-storage-row__actions" @click.stop>
                      <v-tooltip location="top" text="View details">
                        <template #activator="{ props: ap }">
                          <v-btn
                            v-bind="ap"
                            icon
                            variant="text"
                            size="x-small"
                            density="comfortable"
                            @click.stop="openStorageDetails(f)"
                          >
                            <v-icon size="18">info</v-icon>
                          </v-btn>
                        </template>
                      </v-tooltip>
                      <v-tooltip location="top" text="Add to queue">
                        <template #activator="{ props: ap }">
                          <v-btn
                            v-bind="ap"
                            icon
                            variant="text"
                            size="x-small"
                            density="comfortable"
                            :disabled="!isOnline || addingStorageId === f.fileStorageId"
                            :loading="addingStorageId === f.fileStorageId"
                            @click.stop="addStorageToQueue(f)"
                          >
                            <v-icon size="18" color="success">add_to_queue</v-icon>
                          </v-btn>
                        </template>
                      </v-tooltip>
                    </div>
                  </button>
                </div>
              </v-card-text>
            </v-card>
          </v-tabs-window-item>

          <!-- ── Internal Storage (printer USB) ── -->
          <v-tabs-window-item value="internal">
            <v-card variant="outlined" class="pdv-card">
              <v-card-title class="d-flex align-center flex-wrap py-2" style="gap: 8px;">
                <v-spacer />
                <v-text-field
                  v-model="filesSearch"
                  prepend-inner-icon="search"
                  placeholder="Filter…"
                  density="compact"
                  hide-details
                  clearable
                  style="max-width: 200px;"
                />
                <!-- Sort menu — newest first by default, same idea as
                     the Storage tab. Folders only sort by name, so the
                     menu's other options just affect the file order. -->
                <v-menu location="bottom end">
                  <template #activator="{ props: ap }">
                    <v-btn
                      v-bind="ap"
                      icon
                      variant="text"
                      size="x-small"
                      density="comfortable"
                      title="Sort"
                    >
                      <v-icon size="16">sort</v-icon>
                    </v-btn>
                  </template>
                  <v-list density="compact" min-width="180">
                    <v-list-subheader>Sort by</v-list-subheader>
                    <v-list-item
                      v-for="opt in internalSortOptions"
                      :key="opt.value"
                      :active="internalSortBy === opt.value"
                      @click="internalSortBy = opt.value"
                    >
                      <template #prepend>
                        <v-icon size="16">{{ opt.icon }}</v-icon>
                      </template>
                      <v-list-item-title>{{ opt.label }}</v-list-item-title>
                      <template #append>
                        <v-icon
                          v-if="internalSortBy === opt.value"
                          size="14"
                          color="primary"
                        >check</v-icon>
                      </template>
                    </v-list-item>
                  </v-list>
                </v-menu>
                <v-btn
                  icon
                  variant="text"
                  size="x-small"
                  density="comfortable"
                  title="Upload"
                  :disabled="!isOnline || filesUploading"
                  :loading="filesUploading"
                  @click="filesInputRef?.click()"
                >
                  <v-icon size="16">upload</v-icon>
                </v-btn>
                <input
                  ref="filesInputRef"
                  type="file"
                  accept=".gcode,.bgcode,.3mf"
                  style="display: none;"
                  @change="onFilesPicked"
                >
                <v-btn
                  icon
                  variant="text"
                  size="x-small"
                  density="comfortable"
                  title="New folder"
                  :disabled="!isOnline"
                  @click="newFolderOpen = true"
                >
                  <v-icon size="16">create_new_folder</v-icon>
                </v-btn>
              </v-card-title>
              <v-divider />
              <v-card-text>
                <!-- Breadcrumb -->
                <div class="mb-2 text-body-2 text-medium-emphasis pdv-files-crumbs">
                  <a
                    href="#"
                    class="pdv-crumb pdv-crumb--home"
                    title="Root"
                    @click.prevent="navigateFilesTo('')"
                  >
                    <v-icon size="16">home</v-icon>
                  </a>
                  <template v-for="(seg, i) in filesBreadcrumb" :key="i">
                    <span class="mx-1">/</span>
                    <a
                      href="#"
                      class="pdv-crumb"
                      @click.prevent="navigateFilesTo(filesBreadcrumb.slice(0, i + 1).join('/'))"
                    >{{ seg }}</a>
                  </template>
                </div>

                <!-- Body -->
                <div v-if="filesLoading" class="pdv-empty">
                  <v-progress-circular indeterminate size="20" width="2" />
                </div>
                <div
                  v-else-if="!filesData || (filteredDirs.length === 0 && filteredFiles.length === 0)"
                  class="pdv-empty"
                >
                  <v-icon size="40" color="medium-emphasis">folder_off</v-icon>
                  <p class="text-body-2 text-medium-emphasis mt-2">
                    {{ filesSearch ? 'No matches for that filter.' : 'No files here.' }}
                  </p>
                  <v-btn
                    v-if="filesPath && !filesSearch"
                    size="small"
                    variant="text"
                    class="mt-2"
                    @click="navigateFilesTo(parentPathOf(filesPath))"
                  >
                    ↑ Up one level
                  </v-btn>
                </div>
                <div v-else class="pdv-storage-list">
                  <button
                    v-if="filesPath && !filesSearch"
                    type="button"
                    class="pdv-storage-row pdv-storage-row--up"
                    @click="navigateFilesTo(parentPathOf(filesPath))"
                  >
                    <v-icon size="20" class="pdv-storage-row__leadicon">arrow_upward</v-icon>
                    <span class="pdv-storage-row__name">..</span>
                  </button>

                  <button
                    v-for="d in filteredDirs"
                    :key="`d:${d.path}`"
                    type="button"
                    class="pdv-storage-row pdv-storage-row--folder"
                    @click="navigateFilesTo(d.path)"
                  >
                    <v-icon size="22" class="pdv-storage-row__leadicon">folder</v-icon>
                    <div class="pdv-storage-row__body">
                      <div class="pdv-storage-row__title text-truncate" :title="leafName(d.path)">
                        {{ leafName(d.path) }}
                      </div>
                      <div class="pdv-storage-row__meta">
                        <span>Folder</span>
                      </div>
                    </div>
                    <div class="pdv-storage-row__actions" @click.stop>
                      <v-tooltip location="top" text="Delete folder">
                        <template #activator="{ props: ap }">
                          <v-btn
                            v-bind="ap"
                            icon
                            variant="text"
                            size="x-small"
                            density="comfortable"
                            :loading="deletingUsbPath === d.path"
                            @click.stop="deleteUsbEntry(d.path, true)"
                          >
                            <v-icon size="18">delete_outline</v-icon>
                          </v-btn>
                        </template>
                      </v-tooltip>
                    </div>
                  </button>

                  <button
                    v-for="f in filteredFiles"
                    :key="`f:${f.path}`"
                    type="button"
                    class="pdv-storage-row pdv-storage-row--file"
                  >
                    <v-icon size="22" class="pdv-storage-row__leadicon">insert_drive_file</v-icon>
                    <div class="pdv-storage-row__body">
                      <div class="pdv-storage-row__titlerow">
                        <span class="pdv-storage-row__title text-truncate" :title="usbDisplayLabel(f)">
                          {{ usbDisplayLabel(f) }}
                        </span>
                        <v-chip
                          v-if="usbFileFormat(f)"
                          size="x-small"
                          variant="tonal"
                          :color="storageFormatChipColor(usbFileFormat(f))"
                          density="comfortable"
                          class="pdv-storage-row__chip"
                        >
                          {{ usbFileFormat(f)!.toUpperCase() }}
                        </v-chip>
                      </div>
                      <div class="pdv-storage-row__meta">
                        <span v-if="formatStorageSize(f.size ?? null)">
                          {{ formatStorageSize(f.size ?? null) }}
                        </span>
                        <span v-if="f.date">
                          · {{ formatRelativeDate(new Date(f.date * 1000)) }}
                        </span>
                      </div>
                    </div>
                    <div class="pdv-storage-row__actions" @click.stop>
                      <v-tooltip location="top" text="Start print now">
                        <template #activator="{ props: ap }">
                          <v-btn
                            v-bind="ap"
                            icon
                            variant="text"
                            size="x-small"
                            density="comfortable"
                            :disabled="!isOnline"
                            @click.stop="startUsbPrint(f.path)"
                          >
                            <v-icon size="18">play_arrow</v-icon>
                          </v-btn>
                        </template>
                      </v-tooltip>
                      <v-tooltip location="top" text="Add to queue">
                        <template #activator="{ props: ap }">
                          <v-btn
                            v-bind="ap"
                            icon
                            variant="text"
                            size="x-small"
                            density="comfortable"
                            :disabled="!isOnline || addingToQueuePath === f.path"
                            :loading="addingToQueuePath === f.path"
                            @click.stop="addUsbToQueue(f)"
                          >
                            <v-icon size="18" color="success">add_to_queue</v-icon>
                          </v-btn>
                        </template>
                      </v-tooltip>
                      <v-tooltip location="top" text="Delete">
                        <template #activator="{ props: ap }">
                          <v-btn
                            v-bind="ap"
                            icon
                            variant="text"
                            size="x-small"
                            density="comfortable"
                            :loading="deletingUsbPath === f.path"
                            @click.stop="deleteUsbEntry(f.path, false)"
                          >
                            <v-icon size="18">delete_outline</v-icon>
                          </v-btn>
                        </template>
                      </v-tooltip>
                    </div>
                  </button>
                </div>
              </v-card-text>
            </v-card>

            <!-- New-folder inline dialog. Scoped to this sub-tab — the
                 cancel/close path stays local instead of opening a
                 global confirm. -->
            <v-dialog v-model="newFolderOpen" max-width="360">
              <v-card>
                <v-card-title class="text-subtitle-1">Create folder</v-card-title>
                <v-card-text>
                  <v-text-field
                    v-model="newFolderName"
                    label="Folder name"
                    density="compact"
                    autofocus
                    @keyup.enter="createNewFolder"
                  />
                  <p class="text-caption text-medium-emphasis">
                    Created under {{ filesPath || 'root' }}
                  </p>
                </v-card-text>
                <v-card-actions>
                  <v-spacer />
                  <v-btn variant="text" @click="newFolderOpen = false">Cancel</v-btn>
                  <v-btn
                    color="primary"
                    variant="tonal"
                    :disabled="!newFolderName.trim()"
                    :loading="newFolderSubmitting"
                    @click="createNewFolder"
                  >
                    Create
                  </v-btn>
                </v-card-actions>
              </v-card>
            </v-dialog>
          </v-tabs-window-item>

            </v-tabs-window>
          </section>
          </v-col>
          </v-row>
        </div>
      </v-tabs-window-item>

      <!-- ========== HISTORY ========== -->
      <v-tabs-window-item value="history">
        <div class="pdv-content">
          <section class="pdv-section">
            <header class="pdv-section__header">
              <span class="pdv-section__label">At a glance</span>
              <span class="pdv-section__hint">Across the last 50 jobs</span>
            </header>
            <v-row dense>
              <v-col v-for="stat in stats" :key="stat.label" cols="6" sm="3">
                <v-card variant="outlined" :color="stat.color">
                  <v-card-text class="py-3">
                    <div class="text-caption text-medium-emphasis">{{ stat.label }}</div>
                    <div class="text-h6 mt-1">{{ stat.value }}</div>
                    <div v-if="stat.sub" class="text-caption text-medium-emphasis mt-1">
                      {{ stat.sub }}
                    </div>
                  </v-card-text>
                </v-card>
              </v-col>
            </v-row>
          </section>

          <section v-if="durationChartData.length > 0" class="pdv-section">
            <header class="pdv-section__header">
              <span class="pdv-section__label">Estimated vs actual</span>
              <span class="pdv-section__hint">Last {{ durationChartData.length }} completed prints</span>
            </header>
            <v-card variant="outlined" class="pdv-card">
              <v-card-text>
            <svg
              :viewBox="`0 0 ${chartWidth} ${chartHeight}`"
              class="pdv-chart"
              preserveAspectRatio="none"
              role="img"
            >
              <g
                v-for="(d, idx) in durationChartData"
                :key="d.jobId"
                :transform="`translate(${idx * (barGroupWidth + barGap)}, 0)`"
              >
                <rect
                  :x="0"
                  :y="chartHeight - estimatedHeight(d)"
                  :width="barWidth"
                  :height="estimatedHeight(d)"
                  rx="1"
                  fill="rgba(120, 160, 200, 0.45)"
                >
                  <title>Estimated: {{ formatDuration(d.estimatedSeconds) }}</title>
                </rect>
                <rect
                  :x="barWidth + 1"
                  :y="chartHeight - actualHeight(d)"
                  :width="barWidth"
                  :height="actualHeight(d)"
                  rx="1"
                  :fill="d.actualSeconds > d.estimatedSeconds ? '#e07a5f' : '#7ac74f'"
                >
                  <title>Actual: {{ formatDuration(d.actualSeconds) }}</title>
                </rect>
              </g>
            </svg>
              </v-card-text>
            </v-card>
          </section>

          <section class="pdv-section">
            <header class="pdv-section__header">
              <span class="pdv-section__label">Recent jobs</span>
              <v-progress-circular
                v-if="historyLoading"
                indeterminate
                size="14"
                width="2"
              />
            </header>
            <v-card variant="outlined" class="pdv-card">
            <v-data-table
              :headers="historyHeaders"
              :items="historyItems"
              :loading="historyLoading"
              density="comfortable"
              hover
              class="pdv-table"
              @click:row="onHistoryRowClick"
            >
              <template #item.status="{ item }">
                <v-chip
                  :color="statusColor(item.status)"
                  size="x-small"
                  variant="tonal"
                  density="comfortable"
                >
                  {{ statusLabel(item.status) }}
                </v-chip>
              </template>
              <template #item.startedAt="{ item }">
                {{ formatDateOrDash(item.startedAt) }}
              </template>
              <template #item.duration="{ item }">
                {{ formatDuration(item.durationSeconds) }}
              </template>
              <template #item.estimated="{ item }">
                {{ formatDuration(item.estimatedSeconds) }}
              </template>
              <template #item.delta="{ item }">
                <span
                  v-if="item.deltaSeconds !== null"
                  :class="item.deltaSeconds >= 0 ? 'text-error' : 'text-success'"
                >
                  {{ item.deltaSeconds >= 0 ? '+' : '' }}{{ formatDuration(Math.abs(item.deltaSeconds)) }}
                </span>
                <span v-else class="text-medium-emphasis">—</span>
              </template>
            </v-data-table>
            </v-card>
          </section>
        </div>
      </v-tabs-window-item>

      <!-- ========== MAINTENANCE ========== -->
      <v-tabs-window-item value="maintenance">
        <div class="pdv-content">
          <section class="pdv-section">
            <header class="pdv-section__header">
              <span class="pdv-section__label">Maintenance log</span>
              <span class="pdv-section__hint">
                {{ maintenanceLogs.filter(l => !l.completed).length }} active ·
                {{ maintenanceLogs.filter(l => l.completed).length }} resolved
              </span>
              <v-spacer />
              <v-progress-circular
                v-if="maintenanceLoading"
                indeterminate
                size="14"
                width="2"
              />
              <v-btn
                size="small"
                color="primary"
                variant="tonal"
                prepend-icon="build"
                @click="openCreateMaintenance"
              >
                Log maintenance
              </v-btn>
            </header>
          <div v-if="maintenanceLogs.length === 0 && !maintenanceLoading" class="pdv-empty pdv-empty--card">
            <v-icon size="48" color="medium-emphasis">build</v-icon>
            <p class="text-body-1 mt-2">No maintenance entries</p>
            <p class="text-caption text-medium-emphasis">
              Use the Log maintenance button to record an issue or routine service.
            </p>
          </div>
          <div v-else class="pdv-maint-list">
            <div
              v-for="log in maintenanceLogs"
              :key="log.id"
              class="pdv-maint-row"
              :class="{ 'pdv-maint-row--active': !log.completed }"
            >
              <div class="d-flex align-center flex-wrap">
                <v-chip
                  size="x-small"
                  variant="tonal"
                  :color="log.completed ? 'success' : 'warning'"
                  density="comfortable"
                >
                  {{ log.completed ? 'Resolved' : 'Active' }}
                </v-chip>
                <span class="text-body-2 ml-2">
                  {{ log.metadata?.cause || 'Unspecified cause' }}
                </span>
                <v-spacer />
                <span class="text-caption text-medium-emphasis">
                  {{ formatDateOrDash(log.createdAt) }} · {{ log.createdBy || 'unknown' }}
                </span>
                <v-btn
                  v-if="!log.completed"
                  size="x-small"
                  variant="text"
                  color="success"
                  class="ml-2"
                  :loading="completingLogId === log.id"
                  @click="completeMaintenance(log.id)"
                >
                  Mark complete
                </v-btn>
              </div>
              <div
                v-if="log.metadata?.notes"
                class="text-caption text-medium-emphasis mt-1"
              >
                {{ log.metadata.notes }}
              </div>
              <div
                v-if="log.metadata?.partsInvolved?.length"
                class="mt-1"
              >
                <v-chip
                  v-for="part in log.metadata.partsInvolved"
                  :key="part"
                  size="x-small"
                  variant="outlined"
                  density="comfortable"
                  class="mr-1"
                >
                  {{ part }}
                </v-chip>
              </div>
            </div>
          </div>
          </section>
        </div>
      </v-tabs-window-item>

      <!-- ========== CAMERAS ========== -->
      <v-tabs-window-item value="cameras">
        <div class="pdv-content">
          <section class="pdv-section">
            <header class="pdv-section__header">
              <span class="pdv-section__label">Live streams</span>
              <span class="pdv-section__hint" v-if="cameras.length > 0">
                {{ cameras.length }} camera{{ cameras.length === 1 ? '' : 's' }}
              </span>
            </header>
          <div v-if="camerasLoading" class="pdv-empty pdv-empty--card">
            <v-progress-circular indeterminate size="24" />
          </div>
          <div v-else-if="cameras.length === 0" class="pdv-empty pdv-empty--card">
            <v-icon size="48" color="medium-emphasis">videocam_off</v-icon>
            <p class="text-body-1 mt-2">No cameras for this printer</p>
            <p class="text-caption text-medium-emphasis">
              Configure one in the global Cameras page.
            </p>
            <v-btn
              class="mt-3"
              size="small"
              variant="tonal"
              prepend-icon="settings"
              to="/cameras"
            >
              Manage cameras
            </v-btn>
          </div>
          <v-row v-else dense>
            <v-col v-for="cam in cameras" :key="cam.id" cols="12" md="6">
              <v-card variant="outlined" class="pdv-card">
                <v-card-title class="text-subtitle-1 d-flex align-center">
                  <v-icon class="mr-2" color="primary">videocam</v-icon>
                  {{ cam.name || `Camera ${cam.id}` }}
                  <v-spacer />
                  <v-btn
                    icon
                    size="x-small"
                    variant="text"
                    title="Refresh stream"
                    @click="bumpCamRefresh(cam.id!)"
                  >
                    <v-icon size="16">refresh</v-icon>
                  </v-btn>
                </v-card-title>
                <v-divider />
                <v-card-text class="pa-2">
                  <div
                    class="pdv-cam"
                    :style="{
                      aspectRatio: cam.aspectRatio || '16 / 9',
                      transform: cameraTransform(cam),
                    }"
                  >
                    <img
                      :src="cameraStreamSrc(cam)"
                      alt="camera stream"
                      class="pdv-cam__img"
                      @error="onCamLoadError(cam.id!)"
                    >
                  </div>
                </v-card-text>
              </v-card>
            </v-col>
          </v-row>
          </section>
        </div>
      </v-tabs-window-item>

      <!-- ========== SETTINGS ========== -->
      <v-tabs-window-item value="settings">
        <div class="pdv-content">
          <section class="pdv-section">
            <header class="pdv-section__header">
              <span class="pdv-section__label">Configuration</span>
              <v-spacer />
              <v-btn
                size="small"
                color="primary"
                variant="tonal"
                prepend-icon="edit"
                @click="openEditDialog"
              >
                Edit printer
              </v-btn>
            </header>
          <v-row dense>
            <v-col cols="12" md="6">
              <v-card variant="outlined" class="pdv-card">
                <v-card-title class="text-subtitle-2">
                  <v-icon class="mr-2" size="18" color="primary">info</v-icon>
                  Connection
                </v-card-title>
                <v-divider />
                <v-card-text>
                  <dl class="pdv-info">
                    <dt>Name</dt><dd>{{ printer?.name }}</dd>
                    <dt>URL</dt><dd>
                      <a :href="printer?.printerURL" target="_blank" rel="noopener">
                        {{ printer?.printerURL }}
                      </a>
                    </dd>
                    <dt>Type</dt><dd>{{ printerTypeLabel }}</dd>
                    <dt>Enabled</dt><dd>{{ printer?.enabled ? 'Yes' : 'No' }}</dd>
                    <dt v-if="printer?.disabledReason">Reason</dt>
                    <dd v-if="printer?.disabledReason">{{ printer.disabledReason }}</dd>
                    <dt>Created</dt>
                    <dd>{{ formatDateOrDash(printer?.dateAdded ? new Date(printer.dateAdded) : null) }}</dd>
                  </dl>
                </v-card-text>
              </v-card>
            </v-col>
            <v-col cols="12" md="6">
              <v-card variant="outlined" class="pdv-card">
                <v-card-title class="text-subtitle-2">
                  <v-icon class="mr-2" size="18" color="primary">memory</v-icon>
                  Runtime
                </v-card-title>
                <v-divider />
                <v-card-text>
                  <dl class="pdv-info">
                    <dt>Socket</dt><dd>{{ socketStateText }}</dd>
                    <dt>API</dt><dd>{{ apiStateText }}</dd>
                    <dt>State</dt><dd>{{ printerState?.text ?? '—' }}</dd>
                    <dt>Last update</dt>
                    <dd :title="lastSeenIso ?? ''">{{ lastSeenLabel }}</dd>
                  </dl>
                </v-card-text>
              </v-card>
            </v-col>
          </v-row>
          </section>
        </div>
      </v-tabs-window-item>
    </v-tabs-window>

    <!-- History row detail dialog. Surfaces full job context (thumbnail,
         failure reason, exact timings, slice metadata) that doesn't
         fit in a single table row. Click any row in History to open. -->
    <v-dialog v-model="historyDetailOpen" max-width="640" scrollable>
      <v-card v-if="historyDetailJob">
        <v-card-title class="d-flex align-center justify-space-between">
          <div class="d-flex align-center" style="min-width: 0;">
            <v-chip
              :color="statusColor(historyDetailJob.status)"
              size="small"
              variant="tonal"
              density="comfortable"
              class="mr-2"
            >
              {{ statusLabel(historyDetailJob.status) }}
            </v-chip>
            <span class="text-truncate">{{ displayFileName(historyDetailJob) }}</span>
          </div>
          <v-btn icon="close" variant="text" size="small" @click="historyDetailOpen = false" />
        </v-card-title>
        <v-divider />
        <v-card-text class="pa-0">
          <div class="pdv-hd-preview">
            <FileThumbnailCell
              v-if="historyDetailJob.fileStorageId"
              :file-storage-id="historyDetailJob.fileStorageId"
              :thumbnails="(historyDetailJob.thumbnails as any) || []"
            />
            <v-icon v-else size="64" color="medium-emphasis">image_not_supported</v-icon>
          </div>

          <div class="pa-4">
            <!-- Failure reason takes top billing on a failed job — that's
                 the operator's first question when seeing one in the list. -->
            <v-alert
              v-if="historyDetailJob.statusReason && historyDetailJob.status !== 'COMPLETED'"
              type="error"
              variant="tonal"
              density="compact"
              icon="error_outline"
              class="mb-3"
            >
              <div class="text-caption text-medium-emphasis">Reason</div>
              <div class="text-body-2">{{ historyDetailJob.statusReason }}</div>
            </v-alert>

            <v-row dense>
              <v-col cols="6">
                <div class="text-caption text-medium-emphasis">Started</div>
                <div class="text-body-2">{{ formatDateOrDash(historyDetailJob.startedAt) }}</div>
              </v-col>
              <v-col cols="6">
                <div class="text-caption text-medium-emphasis">Ended</div>
                <div class="text-body-2">{{ formatDateOrDash(historyDetailJob.endedAt) }}</div>
              </v-col>
              <v-col cols="6" class="mt-3">
                <div class="text-caption text-medium-emphasis">Actual duration</div>
                <div class="text-body-2">{{ formatDuration(historyDetailJob.statistics?.actualPrintTimeSeconds) }}</div>
              </v-col>
              <v-col cols="6" class="mt-3">
                <div class="text-caption text-medium-emphasis">Estimated</div>
                <div class="text-body-2">{{ formatDuration(historyDetailJob.metadata?.gcodePrintTimeSeconds) }}</div>
              </v-col>
              <v-col cols="6" class="mt-3">
                <div class="text-caption text-medium-emphasis">Δ vs estimate</div>
                <div
                  v-if="historyDetailDelta !== null"
                  class="text-body-2"
                  :class="historyDetailDelta >= 0 ? 'text-error' : 'text-success'"
                >
                  {{ historyDetailDelta >= 0 ? '+' : '' }}{{ formatDuration(Math.abs(historyDetailDelta)) }}
                </div>
                <div v-else class="text-body-2 text-medium-emphasis">—</div>
              </v-col>
              <v-col cols="6" class="mt-3">
                <div class="text-caption text-medium-emphasis">Filament</div>
                <div class="text-body-2">{{ historyDetailFilament }}</div>
              </v-col>
              <v-col v-if="historyDetailJob.metadata?.layerHeight" cols="6" class="mt-3">
                <div class="text-caption text-medium-emphasis">Layer height</div>
                <div class="text-body-2">{{ historyDetailJob.metadata.layerHeight }} mm</div>
              </v-col>
              <v-col v-if="historyDetailJob.metadata?.printerModel" cols="6" class="mt-3">
                <div class="text-caption text-medium-emphasis">Sliced for</div>
                <div class="text-body-2">{{ historyDetailJob.metadata.printerModel }}</div>
              </v-col>
              <v-col v-if="historyDetailJob.metadata?.fileSize" cols="6" class="mt-3">
                <div class="text-caption text-medium-emphasis">File size</div>
                <div class="text-body-2">{{ formatFileSizeForDetail(historyDetailJob.metadata.fileSize) }}</div>
              </v-col>
            </v-row>
          </div>
        </v-card-text>
        <v-divider />
        <v-card-actions>
          <v-btn
            v-if="historyDetailJob.fileStorageId"
            variant="text"
            prepend-icon="add"
            :disabled="!isOnline || historyDetailQueueBusy"
            :loading="historyDetailQueueBusy"
            @click="reQueueHistoryJob"
          >
            Queue again
          </v-btn>
          <v-spacer />
          <v-btn variant="text" @click="historyDetailOpen = false">Close</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Storage file details. Opens on storage-row click and surfaces
         every slice metadata field we have in one place — saves the
         operator from drilling into the print-jobs view just to read
         layer height or which printer the file was sliced for. -->
    <v-dialog v-model="storageDetailsOpen" max-width="720" scrollable>
      <v-card v-if="storageDetailsFile">
        <v-card-text class="pdv-storage-details">
          <div class="pdv-storage-details__top">
            <!-- Full-size thumbnail. Falls back to a placeholder when
                 the file has none (3MF without preview, legacy uploads).
                 prefer-largest pulls the highest-resolution thumbnail
                 the slicer embedded so it stays crisp at this size. -->
            <div class="pdv-storage-details__thumb">
              <FileThumbnailCell
                :file-storage-id="storageDetailsFile.fileStorageId"
                :thumbnails="(storageDetailsFile.thumbnails as any) || []"
                prefer-largest
              />
            </div>
            <!-- Identity panel beside the thumbnail: the "title" of
                 the dialog. Format chip sits as a kicker above the
                 filename; the X is anchored absolutely to the top
                 right of this section so it stays put regardless of
                 how many lines the filename wraps to. -->
            <div class="pdv-storage-details__identity">
              <v-btn
                icon="close"
                variant="text"
                size="small"
                density="comfortable"
                class="pdv-storage-details__close"
                @click="storageDetailsOpen = false"
              />
              <v-chip
                v-if="storageDetailsFile.fileFormat"
                size="small"
                variant="tonal"
                :color="storageFormatChipColor(storageDetailsFile.fileFormat)"
                density="comfortable"
                class="pdv-storage-details__chip"
              >
                {{ storageDetailsFile.fileFormat.toUpperCase() }}
              </v-chip>
              <div
                class="pdv-storage-details__filename"
                :title="displayFileName(storageDetailsFile)"
              >
                {{ displayFileName(storageDetailsFile) }}
              </div>
              <div class="pdv-storage-details__stats">
                <div v-if="formatStorageSize(storageDetailsFile.fileSize)" class="pdv-storage-details__stat">
                  <v-icon size="14">data_usage</v-icon>
                  <span>{{ formatStorageSize(storageDetailsFile.fileSize) }}</span>
                </div>
                <div v-if="storageDetailsFile.metadata?.gcodePrintTimeSeconds" class="pdv-storage-details__stat">
                  <v-icon size="14">schedule</v-icon>
                  <span>~{{ formatQueueDuration(storageDetailsFile.metadata.gcodePrintTimeSeconds) }}</span>
                </div>
                <div v-if="storageDetailsFile.metadata?.filamentUsedGrams" class="pdv-storage-details__stat">
                  <v-icon size="14">fitness_center</v-icon>
                  <span>{{ Math.round(storageDetailsFile.metadata.filamentUsedGrams) }} g</span>
                </div>
                <div v-if="storageDetailsFile.metadata?.filamentType" class="pdv-storage-details__stat">
                  <v-icon size="14">science</v-icon>
                  <span>{{ storageDetailsFile.metadata.filamentType }}</span>
                </div>
              </div>
            </div>
          </div>

          <v-divider class="my-3" />

          <div class="text-overline text-medium-emphasis">Slice profile</div>
          <div class="pdv-storage-details__grid">
            <div v-if="storageDetailsFile.metadata?.layerHeight" class="pdv-storage-details__cell">
              <div class="text-caption text-medium-emphasis">Layer height</div>
              <div class="text-body-2">{{ storageDetailsFile.metadata.layerHeight }} mm</div>
            </div>
            <div v-if="storageDetailsFile.metadata?.firstLayerHeight" class="pdv-storage-details__cell">
              <div class="text-caption text-medium-emphasis">First layer</div>
              <div class="text-body-2">{{ storageDetailsFile.metadata.firstLayerHeight }} mm</div>
            </div>
            <div v-if="storageDetailsFile.metadata?.totalLayers" class="pdv-storage-details__cell">
              <div class="text-caption text-medium-emphasis">Total layers</div>
              <div class="text-body-2">{{ storageDetailsFile.metadata.totalLayers }}</div>
            </div>
            <div v-if="storageDetailsFile.metadata?.nozzleDiameterMm" class="pdv-storage-details__cell">
              <div class="text-caption text-medium-emphasis">Nozzle</div>
              <div class="text-body-2">{{ storageDetailsFile.metadata.nozzleDiameterMm }} mm</div>
            </div>
            <div v-if="storageDetailsFile.metadata?.nozzleTemperature" class="pdv-storage-details__cell">
              <div class="text-caption text-medium-emphasis">Nozzle temp</div>
              <div class="text-body-2">{{ storageDetailsFile.metadata.nozzleTemperature }} °C</div>
            </div>
            <div v-if="storageDetailsFile.metadata?.bedTemperature" class="pdv-storage-details__cell">
              <div class="text-caption text-medium-emphasis">Bed temp</div>
              <div class="text-body-2">{{ storageDetailsFile.metadata.bedTemperature }} °C</div>
            </div>
            <div v-if="storageDetailsFile.metadata?.fillDensity" class="pdv-storage-details__cell">
              <div class="text-caption text-medium-emphasis">Infill</div>
              <div class="text-body-2">{{ storageDetailsFile.metadata.fillDensity }}</div>
            </div>
            <div v-if="storageDetailsFile.metadata?.printerModel" class="pdv-storage-details__cell">
              <div class="text-caption text-medium-emphasis">Sliced for</div>
              <div class="text-body-2">{{ storageDetailsFile.metadata.printerModel }}</div>
            </div>
            <div v-if="storageDetailsFile.metadata?.slicerVersion" class="pdv-storage-details__cell">
              <div class="text-caption text-medium-emphasis">Slicer</div>
              <div class="text-body-2 text-truncate" :title="storageDetailsFile.metadata.slicerVersion">
                {{ storageDetailsFile.metadata.slicerVersion }}
              </div>
            </div>
          </div>

          <v-divider class="my-3" />

          <div class="text-caption text-medium-emphasis">
            Added {{ formatRelativeDate(storageDetailsFile.createdAt) }} ·
            ID {{ storageDetailsFile.fileStorageId.slice(0, 8) }}
          </div>
        </v-card-text>
        <v-divider />
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="storageDetailsOpen = false">Close</v-btn>
          <v-btn
            color="success"
            variant="flat"
            prepend-icon="add_to_queue"
            :disabled="!isOnline || addingStorageId === storageDetailsFile.fileStorageId"
            :loading="addingStorageId === storageDetailsFile.fileStorageId"
            @click="addStorageToQueue(storageDetailsFile).then(() => (storageDetailsOpen = false))"
          >
            Add to queue
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'
import { usePrinterStore } from '@/store/printer.store'
import { usePrinterStateStore } from '@/store/printer-state.store'
import { PrintJobService, PrintJobDto } from '@/backend/print-job.service'
import { PrintQueueService, QueuedJob } from '@/backend/print-queue.service'
import { PrinterMaintenanceLogService } from '@/backend/printer-maintenance-log.service'
import { PrinterRemoteFileService } from '@/backend/printer-remote-file.service'
import { FileStorageService } from '@/backend/file-storage.service'
import type { FileMetadata, FolderInfo } from '@/backend/file-storage.service'
import { PrintersService } from '@/backend/printers.service'
import { CameraStreamService } from '@/backend/camera-stream.service'
import type { CameraStream } from '@/models/camera-streams/camera-stream'
import type { PrinterMaintenanceLog } from '@/models/printers/printer-maintenance-log.model'
import type { FilesDto, FileDto } from '@/models/printers/printer-file.model'
import { usePrinterTileThumbnailQuery } from '@/queries/printer-tile-thumbnail.query'
import { interpretStates } from '@/shared/printer-state.constants'
import { useDialog } from '@/shared/dialog.composable'
import { DialogName } from '@/components/Generic/Dialogs/dialog.constants'
import { useSnackbar } from '@/shared/snackbar.composable'
import { confirm as confirmDialog } from '@/shared/confirm-dialog.composable'
import { notifyPrintJobsChanged } from '@/shared/print-jobs-invalidator.composable'
import { derivePrinterAttention } from '@/shared/printer-attention.util'
import { displayFileName } from '@/utils/file-name.util'
import { apiErrorMessage } from '@/utils/error.utils'
import FileThumbnailCell from '@/components/Files/FileThumbnailCell.vue'

const props = defineProps<{ printerId: number }>()

const router = useRouter()
const route = useRoute()
const printerStore = usePrinterStore()
const printerStateStore = usePrinterStateStore()
const maintenanceDialog = useDialog(DialogName.PrinterMaintenanceDialog)
const controlDialog = useDialog(DialogName.PrinterControlDialog)
const addOrUpdateDialog = useDialog(DialogName.AddOrUpdatePrinterDialog)
const snackbar = useSnackbar()

type TabName = 'overview' | 'history' | 'maintenance' | 'cameras' | 'settings'
const TAB_NAMES: TabName[] = ['overview', 'history', 'maintenance', 'cameras', 'settings']
const tab = ref<TabName>('overview')

// Right column of the Print tab toggles between Storage (file-storage,
// the default — what queueable files live in) and Internal Storage
// (printer USB browser). Default lands on Storage because that's the
// list the operator queues from most often.
const storageTab = ref<'storage' | 'internal'>('storage')

// Compact-mode hero: collapses to a single line + thin progress bar
// once the user has scrolled past a threshold. The full layout is
// generous (~220 px when printing) and chews real estate from long
// History / Files / Maintenance lists — past ~120 px down it's worth
// shrinking. Hysteresis gap (collapse at 120, restore at 80) so a
// scroll position right at the threshold doesn't strobe between
// states on every wheel tick.
const isHeroCompact = ref(false)
function onScroll() {
  const y = window.scrollY ?? 0
  if (!isHeroCompact.value && y > 120) isHeroCompact.value = true
  else if (isHeroCompact.value && y < 80) isHeroCompact.value = false
}
onMounted(() => {
  window.addEventListener('scroll', onScroll, { passive: true })
  onScroll()
})
onBeforeUnmount(() => window.removeEventListener('scroll', onScroll))

// Track the open tab in the URL so reload / share keeps you on the same panel.
onMounted(() => {
  const params = new URLSearchParams(window.location.search)
  const t = params.get('tab') as TabName | null
  if (t && TAB_NAMES.includes(t)) tab.value = t

  // Tile's folder button funnels through here with ?storage=internal to
  // pre-select the Internal Storage sub-tab inside the Print tab.
  const s = params.get('storage')
  if (s === 'storage' || s === 'internal') storageTab.value = s

  // Tile's Move/Home button funnels through here with ?autoOpen=control
  // — open the jog dialog as soon as the view mounts, then strip the
  // param so a refresh doesn't re-pop the dialog.
  if (route.query.autoOpen === 'control') {
    void openControlDialog()
    const next = new URLSearchParams(window.location.search)
    next.delete('autoOpen')
    const qs = next.toString()
    window.history.replaceState(null, '', `${window.location.pathname}${qs ? '?' + qs : ''}`)
  }
})
watch(tab, (next) => {
  const params = new URLSearchParams(window.location.search)
  if (next === 'overview') params.delete('tab')
  else params.set('tab', next)
  const url = `${window.location.pathname}${params.toString() ? '?' + params.toString() : ''}`
  window.history.replaceState(null, '', url)
})
watch(storageTab, (next) => {
  const params = new URLSearchParams(window.location.search)
  if (next === 'storage') params.delete('storage')
  else params.set('storage', next)
  const url = `${window.location.pathname}${params.toString() ? '?' + params.toString() : ''}`
  window.history.replaceState(null, '', url)
})

async function openControlDialog() {
  if (!printer.value) return
  await controlDialog.openDialog({ printer: printer.value })
}

async function openEditDialog() {
  if (!props.printerId) return
  await addOrUpdateDialog.openDialog({ id: props.printerId })
}

// ── Print lifecycle actions (mirrors FileExplorerSideNav) ──
const pauseToggleBusy = ref(false)
const stopBusy = ref(false)
const queueProcessingNext = ref(false)

async function clickPausePrint() {
  if (!props.printerId) return
  pauseToggleBusy.value = true
  try {
    await PrintersService.pausePrintJob(props.printerId)
    notifyPrintJobsChanged({ printerId: props.printerId, reason: 'detailview:pause' })
  } catch (e: any) {
    snackbar.openErrorMessage({
      title: 'Could not pause',
      subtitle: e?.message ?? 'Unknown error',
    })
  } finally {
    pauseToggleBusy.value = false
  }
}
async function clickResumePrint() {
  if (!props.printerId) return
  pauseToggleBusy.value = true
  try {
    await PrintersService.resumePrintJob(props.printerId)
    notifyPrintJobsChanged({ printerId: props.printerId, reason: 'detailview:resume' })
  } catch (e: any) {
    snackbar.openErrorMessage({
      title: 'Could not resume',
      subtitle: e?.message ?? 'Unknown error',
    })
  } finally {
    pauseToggleBusy.value = false
  }
}
async function clickStopPrint() {
  if (!props.printerId) return
  const ok = await confirmDialog({
    title: 'Cancel current print?',
    message: 'The print will stop immediately and progress will be lost.',
    hint: "You can restart it from the printer's queue once it's back online.",
    confirmText: 'Cancel print',
    cancelText: 'Keep printing',
    severity: 'danger',
    icon: 'stop_circle',
  })
  if (!ok) return
  stopBusy.value = true
  try {
    await PrintersService.stopPrintJob(props.printerId)
    notifyPrintJobsChanged({ printerId: props.printerId, reason: 'detailview:stop' })
  } catch (e: any) {
    snackbar.openErrorMessage({
      title: 'Could not cancel',
      subtitle: e?.message ?? 'Unknown error',
    })
  } finally {
    stopBusy.value = false
  }
}

async function togglePrinterConnection() {
  if (!props.printerId) return
  try {
    if (isOperational.value) {
      await PrintersService.sendPrinterDisconnectCommand(props.printerId)
    } else {
      await PrintersService.sendPrinterConnectCommand(props.printerId)
    }
  } catch (e: any) {
    snackbar.openErrorMessage({
      title: 'Connection toggle failed',
      subtitle: e?.message ?? 'Unknown error',
    })
  }
}

async function toggleEnabled() {
  if (!props.printerId || !printer.value) return
  try {
    await PrintersService.toggleEnabled(props.printerId, !printer.value.enabled)
  } catch (e: any) {
    snackbar.openErrorMessage({
      title: 'Could not toggle enabled',
      subtitle: e?.message ?? 'Unknown error',
    })
  }
}

async function refreshSocketState() {
  if (!props.printerId) return
  try {
    await PrintersService.refreshSocket(props.printerId)
  } catch (e: any) {
    snackbar.openErrorMessage({
      title: 'Could not refresh',
      subtitle: e?.message ?? 'Unknown error',
    })
  }
}

async function toggleMaintenance() {
  if (!props.printerId) return
  // If already under maintenance, close the active log. Otherwise open
  // the standard creation dialog so the operator can record cause/notes.
  if (isUnderMaintenance.value) {
    try {
      const active = await PrinterMaintenanceLogService.getActiveByPrinterId(props.printerId)
      if (active) await PrinterMaintenanceLogService.complete(active.id, {})
      snackbar.openInfoMessage({ title: 'Maintenance complete' })
      await loadMaintenance()
    } catch (e: any) {
      snackbar.openErrorMessage({
        title: 'Could not end maintenance',
        subtitle: e?.message ?? 'Unknown error',
      })
    }
    return
  }
  await maintenanceDialog.openDialog({ printerId: props.printerId })
  await loadMaintenance()
}

async function processNextInQueue() {
  if (!props.printerId || queueProcessingNext.value) return
  queueProcessingNext.value = true
  try {
    await PrintQueueService.processQueue(props.printerId)
    await loadQueue()
    notifyPrintJobsChanged({ printerId: props.printerId, reason: 'detailview:processNext' })
  } catch (e: any) {
    snackbar.openErrorMessage({
      title: 'Could not start next job',
      subtitle: e?.message ?? 'Unknown error',
    })
  } finally {
    queueProcessingNext.value = false
  }
}

// Remove an individual job from the queue. The "Clear queue" button
// nukes everything; this is the per-row escape hatch.
const removingQueueId = ref<number | null>(null)
async function removeFromQueue(job: QueuedJob) {
  if (!props.printerId) return
  removingQueueId.value = job.id
  try {
    await PrintQueueService.removeFromQueue(props.printerId, job.id)
    await loadQueue()
    notifyPrintJobsChanged({ printerId: props.printerId, reason: 'detailview:removeFromQueue' })
  } catch (e: any) {
    snackbar.openErrorMessage({
      title: 'Could not remove from queue',
      subtitle: e?.message ?? 'Unknown error',
    })
  } finally {
    removingQueueId.value = null
  }
}

// Hero-card display helpers — kept inline since they're only used here
// and the formatting differs slightly from the global PrintJobs view
// (compact, no seconds component, fall back to file path when neither
// a display name nor file name is present).
function displayQueueName(job: QueuedJob): string {
  // USB jobs carry a slicer-friendly display name from the printer;
  // queue rows from file-storage need to lean on the shared helper,
  // which strips hash/timestamp prefixes and prefers `_originalFileName`
  // out of the analysed metadata.
  if (job.usbDisplayName?.trim()) return job.usbDisplayName
  const fromHelper = displayFileName(job, '')
  if (fromHelper) return fromHelper
  return job.usbFilePath ?? '—'
}
function formatHeroFileSize(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
function formatQueueDuration(seconds: number): string {
  if (!seconds || seconds < 60) return `${Math.round(seconds || 0)}s`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}
function formatFilamentGramsHero(v: number | number[] | null | undefined): string {
  if (v == null) return ''
  const total = Array.isArray(v) ? v.reduce((a, b) => a + (b ?? 0), 0) : v
  if (!Number.isFinite(total) || total <= 0) return ''
  return `${Math.round(total)} g`
}

// ── History row → detail dialog ──
const historyDetailOpen = ref(false)
const historyDetailJob = ref<PrintJobDto | null>(null)
const historyDetailQueueBusy = ref(false)

function onHistoryRowClick(_evt: unknown, row: { item: { jobId: number } }) {
  // v-data-table's row-click hands us an event + a row payload. We
  // resolve the underlying PrintJobDto from the cached jobs array so
  // the dialog gets every field (statusReason, statistics, metadata)
  // that the table row didn't surface.
  const id = row?.item?.jobId
  if (!id) return
  const job = jobs.value.find((j) => j.id === id)
  if (!job) return
  historyDetailJob.value = job
  historyDetailOpen.value = true
}

const historyDetailDelta = computed<number | null>(() => {
  const j = historyDetailJob.value
  if (!j) return null
  const actual = j.statistics?.actualPrintTimeSeconds ?? null
  const est = j.metadata?.gcodePrintTimeSeconds ?? null
  if (actual === null || est === null) return null
  return actual - est
})

const historyDetailFilament = computed<string>(() => {
  const v = historyDetailJob.value?.metadata?.filamentUsedGrams
  if (v == null) return '—'
  const total = Array.isArray(v) ? v.reduce((a, b) => a + (b ?? 0), 0) : v
  if (!Number.isFinite(total) || total <= 0) return '—'
  const type = historyDetailJob.value?.metadata?.filamentType
  return type ? `${Math.round(total)} g · ${type}` : `${Math.round(total)} g`
})

function formatFileSizeForDetail(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

async function reQueueHistoryJob() {
  const j = historyDetailJob.value
  if (!props.printerId || !j?.fileStorageId) return
  historyDetailQueueBusy.value = true
  try {
    await PrintQueueService.createJobFromFile(props.printerId, j.fileStorageId)
    snackbar.openInfoMessage({ title: 'Re-queued', subtitle: displayFileName(j) })
    notifyPrintJobsChanged({ printerId: props.printerId, reason: 'detailview:requeue' })
    historyDetailOpen.value = false
    await loadQueue()
  } catch (e: any) {
    snackbar.openErrorMessage({
      title: 'Could not re-queue',
      subtitle: e?.message ?? 'Unknown error',
    })
  } finally {
    historyDetailQueueBusy.value = false
  }
}

async function clearQueue() {
  if (!props.printerId) return
  const count = queue.value.length
  if (count === 0) return
  const ok = await confirmDialog({
    title: `Clear ${count} job${count === 1 ? '' : 's'} from the queue?`,
    message:
      "All queued jobs on this printer will be removed. The currently running print, if any, won't be affected.",
    confirmText: 'Clear queue',
    severity: 'warning',
    icon: 'delete_sweep',
  })
  if (!ok) return
  try {
    await PrintQueueService.clearQueue(props.printerId)
    queue.value = []
    notifyPrintJobsChanged({ printerId: props.printerId, reason: 'detailview:clearQueue' })
  } catch (e: any) {
    snackbar.openErrorMessage({
      title: 'Could not clear queue',
      subtitle: e?.message ?? 'Unknown error',
    })
  }
}

// ── Printer + live state ──
const printer = computed(() => printerStore.printer(props.printerId))
const printerEvents = computed(() => printerStateStore.printerEventsById[props.printerId])
const socketState = computed(() => printerStateStore.socketStatesById[props.printerId])
const printerState = computed(() => {
  if (!printer.value) return null
  return interpretStates(printer.value, socketState.value, printerEvents.value)
})

const stateChipText = computed(() => printer.value?.disabledReason ? 'Maintenance' : (printerState.value?.text || '—'))
const stateChipColor = computed(() => {
  if (printer.value?.disabledReason) return 'warning'
  if (isPrinting.value) return 'success'
  if (isPaused.value) return 'warning'
  if (!isOnline.value) return 'error'
  return 'grey-darken-1'
})
const stateChipIcon = computed<string | null>(() => {
  if (printer.value?.disabledReason) return 'construction'
  if (isPrinting.value) return 'play_arrow'
  if (isPaused.value) return 'pause'
  if (!isOnline.value) return 'wifi_off'
  if (isOperational.value) return 'check_circle'
  return null
})

// Tone class drives a subtle background tint on the page so the
// operator can read the printer's status from peripheral vision —
// green-tint while printing, orange-tint while paused, red-tint when
// offline, otherwise neutral.
const heroToneClass = computed<'printing' | 'paused' | 'offline' | 'maintenance' | 'idle'>(() => {
  if (printer.value?.disabledReason) return 'maintenance'
  if (!isOnline.value) return 'offline'
  if (isPaused.value) return 'paused'
  if (isPrinting.value) return 'printing'
  return 'idle'
})

// Trim http(s):// + trailing slash so the header link reads "192.168.187.29"
// not "http://192.168.187.29/". Keeps the meta row uncluttered.
const shortPrinterURL = computed(() => {
  const url = printer.value?.printerURL ?? ''
  return url.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
})

// Elapsed time of the current print, formatted compactly.
const elapsedFormatted = computed<string | null>(() => {
  const t = currentJob.value?.progress?.printTime
  if (typeof t !== 'number' || t <= 0) return null
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${Math.floor(t)}s`
})

const isOnline = computed(() => socketState.value?.api === 'responding')
const flags = computed(() => printerEvents.value?.current?.payload?.state?.flags)
const isPrinting = computed(() => !!flags.value?.printing)
const isPaused = computed(() => !!flags.value?.paused || !!flags.value?.pausing)
const isOperational = computed(() => !!flags.value?.operational)
const isStoppable = computed(
  () => !!(flags.value?.printing || flags.value?.paused || flags.value?.pausing),
)
const isUnderMaintenance = computed(
  () => !printer.value?.enabled && !!printer.value?.disabledReason,
)

const printerAttention = computed(() =>
  derivePrinterAttention(printer.value, printerEvents.value, socketState.value),
)
const attentionAlertType = computed<'error' | 'warning' | 'info'>(() => {
  const s = printerAttention.value.severity
  if (s === 'critical') return 'error'
  if (s === 'warning') return 'warning'
  return 'info'
})

const firmwareMessage = computed<string | null>(() => {
  const msg = (printerEvents.value?.current?.payload as any)?.printerMessage
  if (!msg || typeof msg !== 'string') return null
  const trimmed = msg.trim()
  if (!trimmed || trimmed.toLowerCase() === 'ok') return null
  return trimmed
})

// ── Current print (live polling) ──
const currentJob = computed(() => printerStateStore.printerJobsById[props.printerId])
const currentFileName = computed(() => {
  const job: any = currentJob.value
  return job?.job?.file?.display ?? job?.job?.file?.name ?? job?.job?.file?.path ?? null
})
const progressPercent = computed(() => {
  const c = currentJob.value?.progress?.completion
  return typeof c === 'number' ? c.toFixed(1) : '0.0'
})

const timeRemainingSeconds = computed<number | null>(() => {
  const v = currentJob.value?.progress?.printTimeLeft
  return typeof v === 'number' && v > 0 ? v : null
})
const timeRemainingFormatted = computed<string | null>(() => {
  const t = timeRemainingSeconds.value
  if (t === null) return null
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${Math.floor(t)}s`
})
const etaClockFormatted = computed<string | null>(() => {
  const t = timeRemainingSeconds.value
  if (t === null) return null
  const eta = new Date(Date.now() + t * 1000)
  const hh = String(eta.getHours()).padStart(2, '0')
  const mm = String(eta.getMinutes()).padStart(2, '0')
  const sameDay = eta.toDateString() === new Date().toDateString()
  return sameDay ? `${hh}:${mm}` : `${hh}:${mm} +1d`
})

const temps = computed(() => {
  const arr: any[] = (printerEvents.value?.current?.payload as any)?.temps
  if (!arr?.length) return null
  return arr[arr.length - 1]
})
const toolTempStr = computed(() => {
  const t = temps.value?.tool0
  return t ? `${Math.round(t.actual)}°/${Math.round(t.target)}°` : null
})
const bedTempStr = computed(() => {
  const t = temps.value?.bed
  return t ? `${Math.round(t.actual)}°/${Math.round(t.target)}°` : null
})

const printerIdRef = computed(() => props.printerId)
const { data: thumbnailRecord } = usePrinterTileThumbnailQuery(printerIdRef)
const thumbnail = computed(() => thumbnailRecord.value?.thumbnailBase64 ?? '')
// Slice-time metadata of the file the printer is currently running.
// Pulled from the same enriched thumbnail endpoint so we don't double
// up the request — the data is already in TanStack's cache.
const currentSliceMetadata = computed(() => thumbnailRecord.value?.job?.metadata ?? null)
const hasSliceMeta = computed(() => {
  const m = currentSliceMetadata.value
  if (!m) return false
  return !!(m.filamentUsedGrams || m.layerHeight || m.printerModel)
})

// Filament summary handles both single-extruder (number) and MMU
// (array of grams per filament) so the card stays useful for either.
const currentFilamentSummary = computed<string | null>(() => {
  const m = currentSliceMetadata.value
  if (!m?.filamentUsedGrams) return null
  const v = m.filamentUsedGrams
  const total = Array.isArray(v) ? v.reduce((a, b) => a + (b ?? 0), 0) : v
  if (!Number.isFinite(total) || total <= 0) return null
  return m.filamentType ? `${Math.round(total)} g · ${m.filamentType}` : `${Math.round(total)} g`
})

// ── Queue ──
const queue = ref<QueuedJob[]>([])
const queueLoading = ref(false)
async function loadQueue() {
  queueLoading.value = true
  try {
    const response = await PrintQueueService.getPrinterQueue(props.printerId)
    queue.value = response.queue ?? []
  } catch (e: any) {
    snackbar.openErrorMessage({
      title: 'Could not load queue',
      subtitle: e?.message ?? 'Unknown error',
    })
  } finally {
    queueLoading.value = false
  }
}

// ── History (via TanStack so the page reflects backend changes on
//    refocus/window-focus the same way the dialog did) ──
const { data: pagedJobs, isLoading: historyLoading } = useQuery({
  queryKey: ['printer-detail-view', () => props.printerId],
  queryFn: async () =>
    PrintJobService.searchJobsPaged({
      searchPrinter: String(props.printerId),
      page: 1,
      pageSize: 50,
    }),
})
const jobs = computed<PrintJobDto[]>(() => pagedJobs.value?.items ?? [])

const stats = computed(() => {
  const completed = jobs.value.filter((j) => j.status === 'COMPLETED')
  const failed = jobs.value.filter((j) => j.status === 'FAILED')
  const cancelled = jobs.value.filter((j) => j.status === 'CANCELLED')
  const totalFilament = completed.reduce(
    (s, j) => s + filamentTotal(j.metadata?.filamentUsedGrams),
    0,
  )
  const totalSeconds = completed.reduce(
    (s, j) => s + (j.statistics?.actualPrintTimeSeconds ?? 0),
    0,
  )
  return [
    { label: 'Completed', value: String(completed.length), sub: `${jobs.value.length} scanned`, color: 'success' },
    { label: 'Failed', value: String(failed.length), sub: `+ ${cancelled.length} cancelled`, color: failed.length > 0 ? 'error' : 'default' },
    { label: 'Filament', value: totalFilament > 0 ? `${(totalFilament / 1000).toFixed(2)} kg` : '0 g', sub: 'across completed', color: 'primary' },
    { label: 'Print time', value: formatDurationCompact(totalSeconds), sub: 'cumulative', color: 'primary' },
  ]
})

interface HistoryRow {
  jobId: number
  status: string
  fileName: string
  startedAt: Date | string | null
  durationSeconds: number | null
  estimatedSeconds: number | null
  deltaSeconds: number | null
}

const historyHeaders = [
  { title: 'Status', key: 'status' },
  { title: 'File', key: 'fileName' },
  { title: 'Started', key: 'startedAt' },
  { title: 'Duration', key: 'duration' },
  { title: 'Estimated', key: 'estimated' },
  { title: 'Δ', key: 'delta' },
]

const historyItems = computed<HistoryRow[]>(() =>
  jobs.value.map((j) => {
    const duration = j.statistics?.actualPrintTimeSeconds ?? null
    const estimated = j.metadata?.gcodePrintTimeSeconds ?? null
    return {
      jobId: j.id,
      status: j.status,
      fileName: j.fileName,
      startedAt: j.startedAt,
      durationSeconds: duration,
      estimatedSeconds: estimated,
      deltaSeconds: duration !== null && estimated !== null ? duration - estimated : null,
    }
  }),
)

// Bar-chart data (same as the dialog version).
interface ChartPoint {
  jobId: number
  estimatedSeconds: number
  actualSeconds: number
}
const durationChartData = computed<ChartPoint[]>(() => {
  const out: ChartPoint[] = []
  for (const j of jobs.value) {
    if (j.status !== 'COMPLETED') continue
    const est = j.metadata?.gcodePrintTimeSeconds ?? null
    const act = j.statistics?.actualPrintTimeSeconds ?? null
    if (est && act) out.push({ jobId: j.id, estimatedSeconds: est, actualSeconds: act })
    if (out.length >= 16) break
  }
  return out.reverse()
})

const chartWidth = 960
const chartHeight = 110
const barGap = 6
const barGroupWidth = computed(() => {
  const groups = Math.max(1, durationChartData.value.length)
  return Math.max(8, (chartWidth - barGap * (groups - 1)) / groups - 1)
})
const barWidth = computed(() => Math.max(3, barGroupWidth.value / 2 - 1))
const chartMaxSeconds = computed(() => {
  let max = 0
  for (const d of durationChartData.value) {
    if (d.estimatedSeconds > max) max = d.estimatedSeconds
    if (d.actualSeconds > max) max = d.actualSeconds
  }
  return max
})
function estimatedHeight(d: ChartPoint): number {
  const max = chartMaxSeconds.value
  if (!max) return 0
  return Math.round((d.estimatedSeconds / max) * (chartHeight - 4))
}
function actualHeight(d: ChartPoint): number {
  const max = chartMaxSeconds.value
  if (!max) return 0
  return Math.round((d.actualSeconds / max) * (chartHeight - 4))
}

// ── Files (printer USB) ──
const filesPath = ref<string>('')
const filesData = ref<FilesDto | null>(null)
const filesLoading = ref(false)
const filesSearch = ref('')
const filesInputRef = ref<HTMLInputElement | null>(null)
const filesUploading = ref(false)
const newFolderOpen = ref(false)
const newFolderName = ref('')
const newFolderSubmitting = ref(false)

const filesBreadcrumb = computed(() =>
  filesPath.value ? filesPath.value.split('/').filter(Boolean) : [],
)

// Client-side filter. The PrusaLink list endpoint doesn't take a
// `search=` param, and the listings we deal with are small enough that
// a full-rerender filter is cheaper than a round-trip per keystroke.
function matchesSearch(name: string): boolean {
  if (!filesSearch.value) return true
  return name.toLowerCase().includes(filesSearch.value.toLowerCase())
}
type InternalSortKey = 'name' | 'date' | 'size'
const internalSortBy = ref<InternalSortKey>('date')
const internalSortOptions: Array<{ value: InternalSortKey; label: string; icon: string }> = [
  { value: 'date', label: 'Newest first', icon: 'event' },
  { value: 'name', label: 'Name (A→Z)', icon: 'sort_by_alpha' },
  { value: 'size', label: 'Largest first', icon: 'data_usage' },
]

const filteredDirs = computed(() => {
  const filtered = (filesData.value?.dirs ?? []).filter((d) => matchesSearch(leafName(d.path)))
  // Folders only sort by name — USB folders don't expose dates / sizes
  // on the PrusaLink listing, so other modes collapse to alphabetical.
  return [...filtered].sort((a, b) => leafName(a.path).localeCompare(leafName(b.path)))
})
const filteredFiles = computed(() => {
  const filtered = (filesData.value?.files ?? []).filter((f) => matchesSearch(usbDisplayLabel(f)))
  const sorted = [...filtered]
  switch (internalSortBy.value) {
    case 'name':
      sorted.sort((a, b) => usbDisplayLabel(a).localeCompare(usbDisplayLabel(b)))
      break
    case 'size':
      sorted.sort((a, b) => (b.size ?? 0) - (a.size ?? 0))
      break
    case 'date':
    default:
      sorted.sort((a, b) => (b.date ?? 0) - (a.date ?? 0))
  }
  return sorted
})

// Format-from-extension for the chip on each USB file row. PrusaLink
// listings don't surface a structured fileFormat field — we infer it
// from the leafName's extension so the operator gets the same
// color-coded readout they see in Storage.
function usbFileFormat(f: FileDto): string | null {
  const leaf = (usbDisplayLabel(f) || leafName(f.path)).toLowerCase()
  const dot = leaf.lastIndexOf('.')
  if (dot < 0) return null
  const ext = leaf.slice(dot + 1)
  if (ext === 'bgcode' || ext === 'gcode' || ext === '3mf') return ext
  return null
}

function leafName(p: string): string {
  return p.split(/[/\\]/).filter(Boolean).pop() ?? p
}
// Prefer the friendly name the server resolved against file-storage so
// PrusaHero-uploaded files don't surface their `<fileStorageId>.gcode`
// UUID basename. Falls back to the literal printer-side filename for
// anything we didn't put there ourselves (e.g. files dropped onto the
// USB stick directly).
function usbDisplayLabel(f: FileDto): string {
  return f.displayName?.trim() || leafName(f.path)
}
function parentPathOf(p: string): string {
  const parts = p.split('/').filter(Boolean)
  parts.pop()
  return parts.join('/')
}
async function loadFiles() {
  if (!props.printerId) return
  filesLoading.value = true
  try {
    const data = await PrinterRemoteFileService.getFiles(
      props.printerId,
      false,
      filesPath.value || undefined,
    )
    filesData.value = data
  } catch (e: any) {
    snackbar.openErrorMessage({
      title: 'Could not load files',
      subtitle: e?.message ?? 'Unknown error',
    })
    filesData.value = { dirs: [], files: [] }
  } finally {
    filesLoading.value = false
  }
}

async function onFilesPicked(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  // Reset the input value so re-selecting the same file fires `change` again.
  if (input) input.value = ''
  if (!file || !printer.value) return
  filesUploading.value = true
  try {
    await PrinterRemoteFileService.uploadFile(printer.value, file, false)
    snackbar.openInfoMessage({
      title: 'Upload complete',
      subtitle: file.name,
    })
    await loadFiles()
  } catch (e: any) {
    snackbar.openErrorMessage({
      title: 'Upload failed',
      subtitle: e?.message ?? 'Unknown error',
    })
  } finally {
    filesUploading.value = false
  }
}

async function createNewFolder() {
  if (!props.printerId || !newFolderName.value.trim()) return
  newFolderSubmitting.value = true
  try {
    // Compose relative path. Slashes in the name are sanitised — folder
    // hierarchy should be created by navigating + creating one level
    // at a time, not by smuggling a path through the name field.
    const safe = newFolderName.value.trim().replace(/[\\/]+/g, '_')
    const fullPath = filesPath.value ? `${filesPath.value}/${safe}` : safe
    await PrinterRemoteFileService.createFolder(props.printerId, fullPath)
    snackbar.openInfoMessage({ title: 'Folder created', subtitle: safe })
    newFolderOpen.value = false
    newFolderName.value = ''
    await loadFiles()
  } catch (e: any) {
    snackbar.openErrorMessage({
      title: 'Could not create folder',
      subtitle: e?.message ?? 'Unknown error',
    })
  } finally {
    newFolderSubmitting.value = false
  }
}

function navigateFilesTo(path: string) {
  filesPath.value = path
  void loadFiles()
}

async function startUsbPrint(path: string) {
  if (!props.printerId) return
  const known = filesData.value?.files.find((f) => f.path === path)
  const label = known ? usbDisplayLabel(known) : leafName(path)
  try {
    await PrinterRemoteFileService.selectAndPrintFile(props.printerId, path, true)
    snackbar.openInfoMessage({ title: 'Print started', subtitle: label })
  } catch (e: any) {
    snackbar.openErrorMessage({
      title: 'Could not start print',
      subtitle: e?.message ?? 'Unknown error',
    })
  }
}

// One-at-a-time guard so the loading spinner stays on the row the user
// clicked even if they're spam-clicking. Keyed by `file.path` since the
// USB file list doesn't carry a stable id.
const addingToQueuePath = ref<string | null>(null)
async function addUsbToQueue(f: FileDto) {
  if (!props.printerId) return
  addingToQueuePath.value = f.path
  const label = usbDisplayLabel(f)
  try {
    await PrintQueueService.createJobFromUsbFile(props.printerId, {
      filePath: f.path,
      displayName: label,
      fileSize: typeof f.size === 'number' ? f.size : undefined,
      addToQueue: true,
    })
    snackbar.openInfoMessage({
      title: 'Added to queue',
      subtitle: label,
    })
    // Refresh both the global jobs list and the on-page queue card so
    // the operator sees the new row immediately.
    notifyPrintJobsChanged({ printerId: props.printerId, reason: 'detailview:queueFromUsb' })
    await loadQueue()
  } catch (e: any) {
    snackbar.openErrorMessage({
      title: 'Could not queue file',
      subtitle: apiErrorMessage(e),
    })
  } finally {
    addingToQueuePath.value = null
  }
}

// Per-row deletion state for the Internal Storage browser. PrusaLink's
// delete endpoint handles both files and folders against the same
// /printer-files/:id route, so we share one helper and key the loading
// indicator by path.
const deletingUsbPath = ref<string | null>(null)
async function deleteUsbEntry(path: string, isFolder: boolean) {
  if (!props.printerId) return
  // Resolve the friendly label the same way the row's title does so
  // the confirm dialog shows what the operator clicked on, not the
  // raw printer-side path.
  const known = filesData.value?.files.find((f) => f.path === path)
  const label = known ? usbDisplayLabel(known) : leafName(path)
  const ok = await confirmDialog({
    title: isFolder ? 'Delete folder?' : 'Delete file?',
    message: label,
    hint: isFolder
      ? 'The folder and everything inside it is removed from the printer.'
      : 'The file is removed from the printer storage.',
    confirmText: 'Delete',
    severity: 'danger',
  })
  if (!ok) return
  deletingUsbPath.value = path
  try {
    await PrinterRemoteFileService.deleteFileOrFolder(props.printerId, path)
    snackbar.openInfoMessage({
      title: isFolder ? 'Folder deleted' : 'File deleted',
      subtitle: label,
    })
    await loadFiles()
  } catch (e: any) {
    snackbar.openErrorMessage({
      title: 'Could not delete',
      subtitle: apiErrorMessage(e),
    })
  } finally {
    deletingUsbPath.value = null
  }
}


// ── Storage panel (file-storage source, in Overview) ──
// Lives in Overview so the operator can queue files without leaving
// the at-a-glance page. Folder-based; root listing by default.
const storagePath = ref<string | null>(null)
const storageFolders = ref<FolderInfo[]>([])
const storageFiles = ref<FileMetadata[]>([])
const storageLoading = ref(false)
const storageSearch = ref('')
const addingStorageId = ref<string | null>(null)

type StorageSortKey = 'name' | 'date' | 'size' | 'time'
const storageSortBy = ref<StorageSortKey>('date')
const storageSortOptions: Array<{ value: StorageSortKey; label: string; icon: string }> = [
  { value: 'date', label: 'Newest first', icon: 'event' },
  { value: 'name', label: 'Name (A→Z)', icon: 'sort_by_alpha' },
  { value: 'size', label: 'Largest first', icon: 'data_usage' },
  { value: 'time', label: 'Longest print', icon: 'schedule' },
]

// Relative date string for the folder meta line. Keeps the row compact
// — "2h ago" instead of a full timestamp — while still letting the
// operator tell what they uploaded today vs. last month.
function formatRelativeDate(input: string | Date): string {
  const d = typeof input === 'string' ? new Date(input) : input
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return ''
  const diffMs = Date.now() - d.getTime()
  const sec = Math.round(diffMs / 1000)
  if (sec < 60) return 'just now'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.round(hr / 24)
  if (day < 30) return `${day}d ago`
  return d.toLocaleDateString()
}

// File-details dialog. Opens on row click and surfaces every slice
// metadata field we have in one place (thumbnail, format, layer/nozzle
// profile, slicer target, totals). The list row stays scannable; the
// dialog is the "drill in" affordance.
const storageDetailsOpen = ref(false)
const storageDetailsFile = ref<FileMetadata | null>(null)
function openStorageDetails(f: FileMetadata) {
  storageDetailsFile.value = f
  storageDetailsOpen.value = true
}

// Server already knows the compatibility matrix per printer (file
// format vs printer type, plus slicer-target model vs firmware model).
// `getAvailableFiles(printerId)` returns the filtered set — we cache
// the storage-id Set and use it to mask incompatible rows out of the
// rich-metadata listing.
const compatibleFileIds = ref<Set<string> | null>(null)
const onlyCompatibleStorage = ref(true)
async function loadCompatibleFileIds() {
  if (!props.printerId) {
    compatibleFileIds.value = null
    return
  }
  try {
    const available = await PrintQueueService.getAvailableFiles(props.printerId, null, true)
    const ids = new Set<string>()
    for (const f of available?.files ?? []) {
      if (f.fileStorageId) ids.add(f.fileStorageId)
    }
    compatibleFileIds.value = ids
  } catch (e) {
    // Fail open: if the compatibility probe errors out we'd rather
    // show every file than hide the operator's library behind a
    // mysterious empty state.
    console.debug('Compatible-files probe failed; showing all storage files.', e)
    compatibleFileIds.value = null
  }
}

const storageBreadcrumb = computed(() =>
  storagePath.value ? storagePath.value.split('/').filter(Boolean) : [],
)
const storageParentPath = computed<string | null>(() => {
  if (!storagePath.value) return null
  const parts = storagePath.value.split('/').filter(Boolean)
  parts.pop()
  return parts.length ? parts.join('/') : null
})
const storageCount = computed(() => storageFolders.value.length + storageFiles.value.length)

// How many files in the current folder are excluded by the compat
// mask. Pure metric for the toolbar hint; not used to drive the list.
const storageHiddenByCompatCount = computed(() => {
  if (!compatibleFileIds.value) return 0
  const set = compatibleFileIds.value
  return storageFiles.value.filter((f) => !set.has(f.fileStorageId)).length
})

function storageMatches(name: string): boolean {
  if (!storageSearch.value) return true
  return name.toLowerCase().includes(storageSearch.value.toLowerCase())
}
const filteredStorageFolders = computed(() => {
  const filtered = storageFolders.value.filter((f) => storageMatches(f.name))
  if (storageSortBy.value === 'date') {
    return [...filtered].sort((a, b) => {
      const da = new Date(a.createdAt as any).getTime()
      const db = new Date(b.createdAt as any).getTime()
      return db - da
    })
  }
  // Folders only sort by name or date — size/time aren't meaningful
  // without a recursive scan, so we collapse those modes to alphabetical.
  return [...filtered].sort((a, b) => a.name.localeCompare(b.name))
})
const filteredStorageFiles = computed(() => {
  // Match against the friendly display name (what the row shows) so typing
  // a slice prefix narrows the list as expected. `fileName` is the UUID
  // stem for PrusaHero-uploaded files and would never match human input.
  let filtered = storageFiles.value.filter((f) => storageMatches(displayFileName(f)))
  // Compatibility mask: hide files the server flagged as
  // incompatible (wrong format for this printer type, or slicer
  // target family ≠ this printer's family). User-togglable via the
  // sort/filter menu so the operator can still see "all of them".
  if (onlyCompatibleStorage.value && compatibleFileIds.value) {
    const set = compatibleFileIds.value
    filtered = filtered.filter((f) => set.has(f.fileStorageId))
  }
  const sorted = [...filtered]
  switch (storageSortBy.value) {
    case 'name':
      sorted.sort((a, b) => displayFileName(a).localeCompare(displayFileName(b)))
      break
    case 'size':
      sorted.sort((a, b) => (b.fileSize ?? 0) - (a.fileSize ?? 0))
      break
    case 'time':
      sorted.sort(
        (a, b) =>
          (b.metadata?.gcodePrintTimeSeconds ?? 0) - (a.metadata?.gcodePrintTimeSeconds ?? 0),
      )
      break
    case 'date':
    default:
      sorted.sort((a, b) => new Date(b.createdAt as any).getTime() - new Date(a.createdAt as any).getTime())
  }
  return sorted
})

// File size in the most readable unit. Sized so KB only shows up when
// the file actually is sub-MB — bgcode/gcode prints typically land in
// MB range, so giving them KB precision would just be visual noise.
function formatStorageSize(bytes: number | null | undefined): string | null {
  if (typeof bytes !== 'number') return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// File-format chip colors keyed to the file's printer-side meaning:
//   .bgcode → primary  (the canonical Buddy print format)
//   .gcode  → info     (legacy Marlin / cross-compatible source)
//   .3mf    → warning  (slicer container, can't be printed directly)
function storageFormatChipColor(fmt?: string | null): string {
  switch ((fmt ?? '').toLowerCase()) {
    case 'bgcode':
      return 'primary'
    case 'gcode':
      return 'info'
    case '3mf':
      return 'warning'
    default:
      return 'grey'
  }
}

async function loadStorage() {
  storageLoading.value = true
  try {
    // Two parallel calls: the full metadata listing (drives the rows)
    // and the compatibility probe (drives the "is this printable here?"
    // mask). Run them concurrently so the panel paints as soon as the
    // slower of the two returns.
    const [response] = await Promise.all([
      FileStorageService.listFiles(storagePath.value, false),
      loadCompatibleFileIds(),
    ])
    storageFolders.value = response.folders ?? []
    storageFiles.value = response.files ?? []
  } catch (e: any) {
    snackbar.openErrorMessage({
      title: 'Could not load storage',
      subtitle: e?.message ?? 'Unknown error',
    })
    storageFolders.value = []
    storageFiles.value = []
  } finally {
    storageLoading.value = false
  }
}

function navigateStorageTo(path: string | null) {
  storagePath.value = path
  void loadStorage()
}

async function addStorageToQueue(f: FileMetadata) {
  if (!props.printerId) return
  addingStorageId.value = f.fileStorageId
  try {
    await PrintQueueService.createJobFromFile(props.printerId, f.fileStorageId)
    // displayFileName prefers metadata._originalFileName over the raw
    // fileName (which is the on-disk UUID-stem for PrusaHero-uploaded
    // files) so the snackbar matches the label on the list row.
    snackbar.openInfoMessage({ title: 'Added to queue', subtitle: displayFileName(f) })
    notifyPrintJobsChanged({ printerId: props.printerId, reason: 'detailview:queueFromStorage' })
    await loadQueue()
  } catch (e: any) {
    snackbar.openErrorMessage({
      title: 'Could not queue file',
      subtitle: apiErrorMessage(e),
    })
  } finally {
    addingStorageId.value = null
  }
}

// ── Cameras (filter the global list down to this printer) ──
const cameras = ref<CameraStream[]>([])
const camerasLoading = ref(false)
// Bumps the cache-buster on the stream URL so the user can force a
// reload — handy when an MJPEG stream stalls and clears with a
// "refresh stream" click instead of a hard page reload.
const camRefresh = ref<Record<number, number>>({})

async function loadCameras() {
  if (!props.printerId) return
  camerasLoading.value = true
  try {
    const all = await CameraStreamService.listCameraStreams()
    cameras.value = (all ?? []).filter((c) => c.printerId === props.printerId)
  } catch (e: any) {
    snackbar.openErrorMessage({
      title: 'Could not load cameras',
      subtitle: e?.message ?? 'Unknown error',
    })
    cameras.value = []
  } finally {
    camerasLoading.value = false
  }
}

function cameraStreamSrc(cam: CameraStream): string {
  const base = cam.streamURL
  const stamp = cam.id ? camRefresh.value[cam.id] : 0
  if (!stamp) return base
  // Append a cache-busting param. Handles both bare URLs and ones that
  // already carry a query string.
  return base + (base.includes('?') ? '&' : '?') + `_r=${stamp}`
}

function cameraTransform(cam: CameraStream): string {
  const parts: string[] = []
  if (cam.rotationClockwise) parts.push(`rotate(${cam.rotationClockwise}deg)`)
  if (cam.flipHorizontal) parts.push('scaleX(-1)')
  if (cam.flipVertical) parts.push('scaleY(-1)')
  return parts.join(' ')
}

function bumpCamRefresh(id: number) {
  camRefresh.value = { ...camRefresh.value, [id]: Date.now() }
}

function onCamLoadError(id: number) {
  // Just log — the broken-image icon in the browser is enough of a
  // visual cue. Toasting on every camera error would spam if the
  // network's flaky.
  // eslint-disable-next-line no-console
  console.warn(`[cameras] stream failed to load for camera ${id}`)
}

// ── Maintenance ──
const maintenanceLogs = ref<PrinterMaintenanceLog[]>([])
const maintenanceLoading = ref(false)
const completingLogId = ref<number | null>(null)
async function loadMaintenance() {
  maintenanceLoading.value = true
  try {
    const response = await PrinterMaintenanceLogService.listLogs({
      printerId: props.printerId,
      page: 1,
      pageSize: 50,
    })
    const list = response.logs ?? []
    maintenanceLogs.value = [
      ...list.filter((l) => !l.completed),
      ...list.filter((l) => l.completed),
    ]
  } catch (e: any) {
    snackbar.openErrorMessage({
      title: 'Could not load maintenance',
      subtitle: e?.message ?? 'Unknown error',
    })
  } finally {
    maintenanceLoading.value = false
  }
}
async function openCreateMaintenance() {
  await maintenanceDialog.openDialog({ printerId: props.printerId })
  await loadMaintenance()
}
async function completeMaintenance(id: number) {
  completingLogId.value = id
  try {
    await PrinterMaintenanceLogService.complete(id, {})
    await loadMaintenance()
  } catch (e: any) {
    snackbar.openErrorMessage({
      title: 'Could not complete',
      subtitle: e?.message ?? 'Unknown error',
    })
  } finally {
    completingLogId.value = null
  }
}

// ── Connection info ──
const printerTypeLabel = computed(() => {
  // 2 = PrusaLink (per server's PrinterTypesEnum). Future types should
  // get added here; falling back to the raw number is fine for unknown.
  return printer.value?.printerType === 2 ? 'PrusaLink' : String(printer.value?.printerType ?? '—')
})
const socketStateText = computed(() => socketState.value?.socket ?? '—')
const apiStateText = computed(() => socketState.value?.api ?? '—')
const lastSeenMs = computed(() => printerStateStore.printerCurrentEventReceivedAtById[props.printerId] ?? null)
const lastSeenIso = computed(() => (lastSeenMs.value ? new Date(lastSeenMs.value).toISOString() : null))
const lastSeenLabel = computed(() => {
  const ts = lastSeenMs.value
  if (!ts) return 'never'
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (sec < 60) return `${sec}s ago`
  const m = Math.floor(sec / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
})

// ── Initial loads / reactive reloads on printerId / tab change ──
watch(
  () => props.printerId,
  () => {
    void loadQueue()
    void loadMaintenance()
    void loadCameras()
    void loadStorage()
  },
  { immediate: true },
)
// Refresh on tab entry so a stale snapshot doesn't outlive a context
// switch. Cameras are loaded up-front (so the tab can appear/disappear
// based on count) but re-fetched on entry to recover from stale streams.
watch(
  tab,
  (next) => {
    if (next === 'overview') {
      void loadQueue()
      void loadStorage()
    }
    if (next === 'maintenance') void loadMaintenance()
    if (next === 'cameras') void loadCameras()
  },
  { immediate: true },
)
// Lazy-load the USB listing: it only matters once the operator clicks
// over to the Internal Storage sub-tab inside the Print tab. Storage
// (file-storage) is the default sub-tab and loads via the overview
// watcher above.
watch(storageTab, (next) => {
  if (next === 'internal') void loadFiles()
})

// ── Formatters ──
function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return '—'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${Math.floor(seconds)}s`
}
function formatDurationCompact(seconds: number): string {
  if (!seconds || seconds <= 0) return '0m'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}
function formatDateOrDash(value: Date | string | null | undefined): string {
  if (!value) return '—'
  const d = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}
function statusColor(status: string): string {
  switch (status) {
    case 'COMPLETED': return 'success'
    case 'FAILED': return 'error'
    case 'CANCELLED': return 'warning'
    case 'PRINTING': case 'STARTING': return 'primary'
    case 'PAUSED': return 'orange'
    default: return 'default'
  }
}
function statusLabel(status: string): string {
  const map: Record<string, string> = {
    PENDING: 'Pending', QUEUED: 'Queued', STARTING: 'Transferring',
    PRINTING: 'Printing', PAUSED: 'Paused', COMPLETED: 'Completed',
    FAILED: 'Failed', CANCELLED: 'Cancelled', UNKNOWN: 'Unknown',
  }
  return map[status] ?? status
}
function filamentTotal(v: number | number[] | null | undefined): number {
  if (v == null) return 0
  if (Array.isArray(v)) return v.reduce((a, b) => a + (b || 0), 0)
  return v
}
</script>

<style scoped>
.pdv {
  max-width: 1280px;
  margin: 0 auto;
}

.pdv-missing {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 64px 24px;
  text-align: center;
}

/* ---- Hero header (sticky, state-tinted) ---- */
.pdv-hero-header {
  position: sticky;
  top: 0;
  z-index: 3;
  padding: 14px 20px 12px;
  background: rgb(var(--v-theme-surface));
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
  transition: padding 180ms ease;
}

/* Compact mode: top row stays (identity + secondary icons), the
   thumbnail/progress/stats now-row hides, and a tight compact-row
   takes its place with just filename + percent + Pause/Cancel. */
.pdv-hero-header--compact {
  padding-top: 8px;
  padding-bottom: 0;
}
.pdv-hero-header--compact .pdv-hero-header__now {
  display: none;
}
.pdv-hero-header--compact .pdv-hero-header__name {
  font-size: 16px;
}
.pdv-hero-header--compact .pdv-hero-header__meta {
  /* When collapsed, the meta row gets less prominence so the compact
     summary line below can take the focus. */
  font-size: 11px;
  gap: 6px;
}

.pdv-hero-header__top {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

/* Top-right action cluster. Holds two groups separated by a thin
   vertical rule: the always-visible secondary icons (USB / enable /
   refresh / maintenance) and the print-time primary chips (Pause /
   Cancel / Jog) when there's an active print. */
.pdv-hero-header__actions {
  display: flex;
  align-items: center;
  align-content: center;
  gap: 4px;
  flex-shrink: 0;
  padding: 4px 6px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
  flex-wrap: wrap;
}

/* Force every v-btn inside the cluster — icon button or chip — to
   the same 30px height. Without this the icon buttons sit at
   size="small" (~36px) and the chips at size="x-small" (~24px), and
   when they wrap to a second row the mismatch reads as off-center.
   A single height plus align-items: center fixes the centering for
   both rows. */
.pdv-hero-header__actions :deep(.v-btn) {
  min-height: 30px;
  height: 30px;
}

/* Thin vertical rule between the secondary icons and the primary
   chips. Gives the two groups breathing room without taking horizontal
   space the way an extra wrapper would. */
.pdv-hero-header__actions-sep {
  width: 1px;
  height: 18px;
  margin: 0 4px;
  background: rgba(255, 255, 255, 0.12);
  flex-shrink: 0;
}

.pdv-hero-header__identity {
  flex: 1 1 auto;
  min-width: 0;
}

.pdv-hero-header__name {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: -0.01em;
  line-height: 1.2;
  margin: 0;
}

.pdv-hero-header__meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 4px;
}

.pdv-hero-header__fw {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgba(var(--v-theme-on-surface), 0.7);
}

.pdv-hero-header__service {
  font-size: 12px;
}
.pdv-hero-header__service a {
  color: inherit;
  text-decoration: none;
}
.pdv-hero-header__service a:hover {
  text-decoration: underline;
}

.pdv-hero-header__now {
  margin-top: 14px;
  display: flex;
  gap: 14px;
  align-items: stretch;
}

.pdv-hero-header__thumb {
  flex: 0 0 112px;
  width: 112px;
  height: 112px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.06);
}
.pdv-hero-header__thumb :deep(.v-img),
.pdv-hero-header__thumb :deep(img) {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.pdv-hero-header__now-body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
}

.pdv-hero-header__progress-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 2px;
}

.pdv-hero-header__file {
  font-size: 13px;
  flex: 1 1 auto;
  min-width: 0;
  color: rgba(var(--v-theme-on-surface), 0.85);
}

.pdv-hero-header__percent {
  font-weight: 700;
  font-size: 16px;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

/* Subtle state tint on the hero so the printer's mood reads at a glance
   before the operator parses any text. Stays muted enough not to fight
   the content below. */
.pdv--printing .pdv-hero-header {
  background: linear-gradient(180deg, rgba(76, 175, 80, 0.08), rgb(var(--v-theme-surface)) 90%);
}
.pdv--paused .pdv-hero-header {
  background: linear-gradient(180deg, rgba(255, 152, 0, 0.10), rgb(var(--v-theme-surface)) 90%);
}
.pdv--offline .pdv-hero-header {
  background: linear-gradient(180deg, rgba(244, 67, 54, 0.08), rgb(var(--v-theme-surface)) 90%);
}
.pdv--maintenance .pdv-hero-header {
  background: linear-gradient(180deg, rgba(255, 193, 7, 0.10), rgb(var(--v-theme-surface)) 90%);
}

/* ---- Stats strip (inline temps + elapsed + remaining + ETA) ---- */
.pdv-stats {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  margin-top: 8px;
  font-size: 12px;
  color: rgba(var(--v-theme-on-surface), 0.7);
}
.pdv-stats__item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-variant-numeric: tabular-nums;
}

/* Slice-metadata row sits directly under the stats line — slightly
   smaller and dimmer so it reads as "context about the file" vs
   "live runtime". */
.pdv-slice {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  font-size: 11px;
  color: rgba(var(--v-theme-on-surface), 0.55);
}
.pdv-slice__item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

/* Compact-mode summary row + thin bottom progress bar. The progress
   bar is negative-margin'd into the hero's border so it visually
   replaces the bottom border, keeping the page chrome at the same
   height. */
.pdv-hero-header__compact-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  padding-bottom: 8px;
  font-size: 13px;
}
.pdv-hero-header__compact-file {
  flex: 1 1 auto;
  min-width: 0;
  color: rgba(var(--v-theme-on-surface), 0.85);
}
.pdv-hero-header__compact-pct {
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.pdv-hero-header__compact-eta {
  color: rgba(var(--v-theme-on-surface), 0.6);
  font-variant-numeric: tabular-nums;
}

.pdv-hero-header__progress-bottom {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  border-radius: 0;
}

.pdv-tabs {
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.pdv-attention {
  margin: 8px 16px 0;
}

.pdv-card {
  height: 100%;
  border-color: rgba(255, 255, 255, 0.08);
}

/* ---- Sectioned content layout ---- */
/* Each major chunk of a tab (Now printing / Queue / Storage / etc.)
   is wrapped in <section class="pdv-section"> with a small header
   above it. Sections stack with generous spacing so the page reads as
   a series of zones rather than a stream of cards. */
.pdv-content {
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding: 20px 24px 32px;
  max-width: 1280px;
  margin: 0 auto;
}

.pdv-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.pdv-section__header {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 0 4px;
}

.pdv-section__label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: rgba(var(--v-theme-on-surface), 0.6);
}

.pdv-section__hint {
  font-size: 12px;
  color: rgba(var(--v-theme-on-surface), 0.45);
  font-variant-numeric: tabular-nums;
}

.pdv-current-card {
  overflow: hidden;
}

.pdv-current {
  display: flex;
  gap: 16px;
  align-items: stretch;
}

.pdv-current__thumb {
  flex: 0 0 240px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.3);
  border-radius: 6px;
  min-height: 240px;
  overflow: hidden;
}

.pdv-current__info {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.pdv-current__name {
  margin-top: 2px;
  margin-bottom: 14px;
}

.pdv-current__stats {
  display: grid;
  grid-template-columns: max-content 1fr;
  column-gap: 16px;
  row-gap: 6px;
  font-size: 13px;
}
.pdv-current__stats dt {
  color: rgba(var(--v-theme-on-surface), 0.65);
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.pdv-current__stats dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}

.pdv-empty {
  padding: 24px;
  text-align: center;
}
.pdv-empty--card {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 40px 16px;
}

.pdv-queue-list {
  list-style: none;
  padding: 0;
  margin: 8px 0 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.pdv-queue-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.025);
  border: 1px solid rgba(var(--v-theme-primary), 0.06);
  transition: background-color 0.12s ease, border-color 0.12s ease;
}
.pdv-queue-row:hover {
  background: rgba(var(--v-theme-primary), 0.06);
  border-color: rgba(var(--v-theme-primary), 0.18);
}

/* Position badge: small circular chip carrying the queue index so
   it reads as a serial number rather than a loose digit. */
.pdv-queue-row__pos {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  font-size: 11px;
  font-weight: 700;
  color: rgba(var(--v-theme-on-surface), 0.7);
  background: rgba(var(--v-theme-primary), 0.12);
}

/* Compact 32×32 thumbnail slot. Same chassis as the storage row
   thumbnail but smaller — the queue list is denser. */
.pdv-queue-row__thumb {
  width: 32px;
  height: 32px;
  border-radius: 4px;
  overflow: hidden;
  background: rgba(0, 0, 0, 0.25);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.pdv-queue-row__thumb :deep(.thumbnail-container) {
  width: 100%;
  height: 100%;
  border-radius: 0;
  cursor: default;
}
.pdv-queue-row__thumb :deep(*) {
  pointer-events: none;
}
.pdv-queue-row__thumb :deep(img),
.pdv-queue-row__thumb :deep(.v-img),
.pdv-queue-row__thumb :deep(.thumbnail-image) {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.pdv-queue-row__body {
  flex: 1 1 auto;
  min-width: 0;
}

.pdv-queue-row__titlerow {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.pdv-queue-row__name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
}

.pdv-queue-row__chip {
  flex-shrink: 0;
}

.pdv-queue-row__meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 2px;
  font-size: 11px;
  color: rgba(var(--v-theme-on-surface), 0.65);
  margin-top: 2px;
}
.pdv-queue-row__meta v-icon,
.pdv-queue-row__meta .v-icon {
  margin-right: 1px;
  vertical-align: -1px;
}

/* Hero card for the head of the queue — drops the "Next up" label, a
   thumbnail, slice metadata, and a prominent "Send to print" button so
   the operator's primary action is one click. */
.pdv-hero {
  position: relative;
  border-radius: 8px;
  padding: 14px 14px 12px;
  background: linear-gradient(
    180deg,
    rgba(var(--v-theme-primary), 0.07),
    rgba(var(--v-theme-primary), 0.02)
  );
  border: 1px solid rgba(var(--v-theme-primary), 0.18);
}

.pdv-hero--starting {
  border-color: rgba(var(--v-theme-primary), 0.55);
  background: linear-gradient(
    180deg,
    rgba(var(--v-theme-primary), 0.18),
    rgba(var(--v-theme-primary), 0.05)
  );
}

.pdv-hero__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.pdv-hero__label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 700;
  color: rgba(var(--v-theme-primary), 0.85);
}

.pdv-hero__body {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}

.pdv-hero__thumb {
  flex: 0 0 96px;
  width: 96px;
  height: 96px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.3);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.pdv-hero__thumb :deep(.thumbnail-container) {
  width: 100%;
  height: 100%;
  border-radius: 0;
}
.pdv-hero__thumb :deep(*) {
  pointer-events: none;
}
.pdv-hero__thumb :deep(img),
.pdv-hero__thumb :deep(.v-img),
.pdv-hero__thumb :deep(.thumbnail-image) {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.pdv-hero__info {
  flex: 1 1 auto;
  min-width: 0;
}

/* Kicker row above the filename — format chip + transferring chip +
   file size. Keeps the filename's own line uncluttered so it can use
   the full width to wrap. */
.pdv-hero__kicker {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 4px;
}

/* Filename: always shown in full. The whole point of the hero card is
   to let the operator confirm what they're about to dispatch, so the
   name wraps to as many lines as it needs instead of truncating. */
.pdv-hero__name {
  font-weight: 600;
  font-size: 14px;
  line-height: 1.35;
  word-break: break-word;
  white-space: normal;
}

.pdv-hero__stats {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 8px;
  font-size: 12px;
  color: rgba(var(--v-theme-on-surface), 0.7);
}

.pdv-hero__stat {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

/* Bottom action bar — Send to print sits on its own row aligned right
   so the body above can spread to the full card width for the
   filename instead of fighting for horizontal room. */
.pdv-hero__actionbar {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}

.pdv-chart {
  width: 100%;
  height: 110px;
  display: block;
  background: rgba(255, 255, 255, 0.02);
  border-radius: 4px;
  padding: 2px 4px;
}

.pdv-table :deep(.v-data-table-footer) {
  display: none;
}
.pdv-table :deep(tbody tr) {
  cursor: pointer;
}

/* History row → detail dialog: large thumbnail strip at the top so
   the operator can identify the print at a glance, then a grid of
   stats and an optional failure-reason alert. */
.pdv-hd-preview {
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.3);
  min-height: 220px;
  overflow: hidden;
}
.pdv-hd-preview :deep(.v-img),
.pdv-hd-preview :deep(img) {
  width: 100%;
  height: 100%;
  max-height: 280px;
  object-fit: contain;
}

.pdv-maint-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.pdv-maint-row {
  padding: 10px 12px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.05);
}

.pdv-maint-row--active {
  border-color: rgba(var(--v-theme-warning), 0.4);
  background: rgba(var(--v-theme-warning), 0.06);
}

.pdv-info {
  display: grid;
  grid-template-columns: 110px 1fr;
  gap: 6px 12px;
  font-size: 14px;
}

.pdv-info dt {
  color: rgba(var(--v-theme-on-surface), 0.6);
  font-weight: 500;
}

.pdv-info dd {
  margin: 0;
  word-break: break-all;
}

.pdv-crumb {
  color: rgba(var(--v-theme-primary), 0.85);
  text-decoration: none;
}
.pdv-crumb:hover {
  text-decoration: underline;
}

/* The home crumb is the v-icon-only entry point at the start of the
   trail. Aligns the icon to the baseline of the text crumbs and kills
   the underline-on-hover (the icon already has its own hover shade). */
.pdv-crumb--home {
  display: inline-flex;
  align-items: center;
  vertical-align: middle;
  opacity: 0.85;
}
.pdv-crumb--home:hover {
  text-decoration: none;
  opacity: 1;
}

.pdv-files {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 6px;
}

.pdv-files-crumbs {
  font-size: 13px;
}

/* Compact 36×36 thumbnail slot used in the Storage list rows so each
   row reads at a glance which print it is, without blowing up the
   row height the way the queue hero card does. */
.pdv-storage-thumb {
  width: 36px;
  height: 36px;
  border-radius: 4px;
  overflow: hidden;
  background: rgba(0, 0, 0, 0.25);
  margin-right: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.pdv-storage-thumb :deep(img),
.pdv-storage-thumb :deep(.v-img) {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

/* ─── Storage list (rich row layout) ─────────────────────────── */

/* Custom rows replace v-list-item so we can wrap two metadata lines
   under the title, host a chip inline, and reveal the action group on
   hover without fighting Vuetify's internal slot structure. */
.pdv-storage-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 6px;
  padding: 4px;
  background: transparent;
}

.pdv-storage-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  color: inherit;
  font: inherit;
  transition: background-color 0.12s ease, transform 0.12s ease;
}

.pdv-storage-row:hover {
  background: rgba(var(--v-theme-primary), 0.06);
}

.pdv-storage-row:focus-visible {
  outline: 1px solid rgba(var(--v-theme-primary), 0.5);
  outline-offset: -1px;
}

.pdv-storage-row--up,
.pdv-storage-row--folder {
  /* Folders & ".." rows are shorter — only need the name line. */
  min-height: 38px;
}

.pdv-storage-row__leadicon {
  flex-shrink: 0;
  color: rgba(var(--v-theme-on-surface), 0.7);
}

/* Larger 44×44 thumbnail in the list row gives the operator the same
   visual hook as the queue hero. Reads better than the older 36×36 at
   the cost of one more row's worth of vertical space. */
.pdv-storage-row__thumb {
  width: 44px;
  height: 44px;
  border-radius: 4px;
  overflow: hidden;
  background: rgba(0, 0, 0, 0.25);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.pdv-storage-row__thumb :deep(img),
.pdv-storage-row__thumb :deep(.v-img) {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

/* FileThumbnailCell registers its own click handler that opens the
   global FileThumbnailViewer dialog. We don't want that here — the row
   itself drives the click and opens the file-details dialog. Disabling
   pointer events on the cell makes its click invisible while keeping
   the image fully rendered. */
.pdv-storage-row__thumb :deep(*) {
  pointer-events: none;
}

.pdv-storage-row__body {
  flex: 1 1 auto;
  min-width: 0;
}

.pdv-storage-row__titlerow {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.pdv-storage-row__title {
  font-size: 13px;
  font-weight: 600;
  flex: 1 1 auto;
  min-width: 0;
}

.pdv-storage-row__name {
  font-size: 13px;
  font-weight: 500;
}

.pdv-storage-row__chip {
  flex-shrink: 0;
}

.pdv-storage-row__meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 2px;
  font-size: 11px;
  color: rgba(var(--v-theme-on-surface), 0.7);
  margin-top: 2px;
}
.pdv-storage-row__meta--dim {
  color: rgba(var(--v-theme-on-surface), 0.5);
}
.pdv-storage-row__metaicon {
  margin-right: 1px;
  vertical-align: -1px;
}

/* Action cluster on the right. Stays visible on touch (no hover) but
   fades up to full opacity on pointer hover so the row feels less
   cluttered when the operator is just scanning. */
.pdv-storage-row__actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  opacity: 0.65;
  transition: opacity 0.12s ease;
}
.pdv-storage-row:hover .pdv-storage-row__actions {
  opacity: 1;
}

/* ─── Storage file details dialog ────────────────────────────── */

.pdv-storage-details {
  padding-top: 12px;
}

/* Original side-by-side layout: a compact thumbnail square next to the
   headline stats. The thumbnail itself is bigger than the v1 (240
   instead of 160) so the slice preview is legible, but it doesn't
   dominate the dialog. */
.pdv-storage-details__top {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}

.pdv-storage-details__thumb {
  flex-shrink: 0;
  width: 240px;
  height: 240px;
  border-radius: 8px;
  overflow: hidden;
  background:
    repeating-linear-gradient(
      45deg,
      rgba(255, 255, 255, 0.02) 0 10px,
      rgba(255, 255, 255, 0.005) 10px 20px
    ),
    rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(var(--v-theme-primary), 0.16);
}
/* FileThumbnailCell wraps its v-img in a scoped 60×60 container which
   would otherwise center a tiny image inside our 240px slot. Bust
   through with :deep so the inner box stretches to fill the slot and
   the picked thumbnail (~400px native) finally renders close to
   resolution. object-fit: cover so the preview fills the box edge to
   edge — slice previews are roughly square so we don't lose much by
   cropping, and "fill the box" is what the operator asked for. */
.pdv-storage-details__thumb :deep(.thumbnail-container) {
  width: 100%;
  height: 100%;
  border-radius: 0;
}
.pdv-storage-details__thumb :deep(img),
.pdv-storage-details__thumb :deep(.v-img),
.pdv-storage-details__thumb :deep(.v-img__img),
.pdv-storage-details__thumb :deep(.thumbnail-image) {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.pdv-storage-details__primary {
  flex: 1 1 auto;
  min-width: 0;
}

/* Identity panel beside the thumbnail. Vertical flow:
   format-chip kicker → filename → headline stats. Close button is
   positioned absolutely in the top-right corner so it doesn't shift
   when the filename wraps to multiple lines. */
.pdv-storage-details__identity {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  /* Reserve room so a long filename doesn't crash into the X button. */
  padding-right: 36px;
}

.pdv-storage-details__chip {
  align-self: flex-start;
}

.pdv-storage-details__filename {
  font-size: 16px;
  font-weight: 600;
  line-height: 1.3;
  word-break: break-word;
  /* Cap at four lines on overly long filenames so the identity panel
     never grows past the 240px thumbnail height. */
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.pdv-storage-details__close {
  position: absolute;
  top: -4px;
  right: -4px;
}

.pdv-storage-details__stats {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 18px;
  margin-top: 6px;
}
.pdv-storage-details__stat {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 500;
}

/* Two-column metadata grid so the slice profile reads as a spec sheet
   instead of a paragraph. Cells collapse to one column on narrow
   viewports. */
.pdv-storage-details__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 10px 16px;
  margin-top: 4px;
}
.pdv-storage-details__cell {
  min-width: 0;
}

/* ─── Storage hidden-by-compat hint ──────────────────────────── */

.pdv-storage-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: rgba(var(--v-theme-on-surface), 0.6);
  padding: 4px 2px 8px;
}
.pdv-storage-hint a {
  color: rgba(var(--v-theme-primary), 0.9);
  text-decoration: none;
  margin-left: 2px;
}
.pdv-storage-hint a:hover {
  text-decoration: underline;
}


.pdv-cam {
  width: 100%;
  background: #000;
  border-radius: 4px;
  overflow: hidden;
}

.pdv-cam__img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}
</style>
