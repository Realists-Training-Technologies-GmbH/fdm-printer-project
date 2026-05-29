<template>
  <v-container fluid class="print-jobs-container pa-4">
    <!-- ─── Header: tabs + actions ───────────────────────────── -->
    <div class="pj-header">
      <v-tabs
        v-model="activeTab"
        color="primary"
        density="compact"
        class="pj-tabs"
      >
        <v-tab value="jobs">
          <v-icon start size="small">history</v-icon>
          Jobs
          <v-chip
            v-if="totalJobs > 0"
            size="x-small"
            variant="tonal"
            class="ml-2"
          >
            {{ totalJobs }}
          </v-chip>
        </v-tab>
        <v-tab value="queue">
          <v-icon start size="small">queue</v-icon>
          Queue
          <v-chip
            v-if="queueCount > 0"
            size="x-small"
            color="primary"
            variant="tonal"
            class="ml-2"
          >
            {{ queueCount }}
          </v-chip>
        </v-tab>
      </v-tabs>

      <v-spacer />

      <v-btn
        variant="text"
        size="small"
        :prepend-icon="showAdvancedFilters ? 'expand_less' : 'tune'"
        @click="showAdvancedFilters = !showAdvancedFilters"
      >
        {{ showAdvancedFilters ? 'Hide filters' : 'Filters' }}
        <v-chip
          v-if="activeFiltersCount > 0"
          size="x-small"
          color="primary"
          variant="flat"
          class="ml-2"
        >
          {{ activeFiltersCount }}
        </v-chip>
      </v-btn>

      <v-btn
        :loading="activeTab === 'jobs' ? loading : loadingQueue"
        color="primary"
        variant="tonal"
        size="small"
        icon="refresh"
        @click="activeTab === 'jobs' ? loadPrintJobs() : loadQueue()"
      >
        <v-icon>refresh</v-icon>
        <v-tooltip activator="parent" location="bottom">Refresh</v-tooltip>
      </v-btn>
    </div>

    <!-- ─── Quick filters (always visible) ──────────────────── -->
    <v-card class="pj-filters" elevation="0" border>
      <div class="pj-filters__row">
        <v-autocomplete
          v-model="selectedPrinterIds"
          :items="allPrinters"
          item-title="name"
          item-value="id"
          label="Filter by printer"
          prepend-inner-icon="print"
          variant="outlined"
          density="compact"
          multiple
          chips
          clearable
          closable-chips
          hide-details
          class="pj-filter pj-filter--wide"
          @update:model-value="debouncedSearch"
        >
          <template #chip="{ item, props }">
            <v-chip v-bind="props" size="small" closable>
              {{ item.title }}
            </v-chip>
          </template>
        </v-autocomplete>

        <v-text-field
          v-model="searchParams.searchFile"
          label="Search by file name"
          prepend-inner-icon="search"
          variant="outlined"
          density="compact"
          clearable
          hide-details
          class="pj-filter pj-filter--wide"
          @input="debouncedSearch"
        />
      </div>

      <!-- Advanced filters (collapsible) -->
      <v-expand-transition>
        <div v-show="showAdvancedFilters" class="pj-filters__advanced">
          <v-divider class="mb-3" />

          <div class="pj-filters__row">
            <v-text-field
              v-model="searchParams.startDate"
              label="Start date"
              type="date"
              variant="outlined"
              density="compact"
              prepend-inner-icon="event"
              hide-details
              class="pj-filter"
              @input="debouncedSearch"
            />
            <v-text-field
              v-model="searchParams.endDate"
              label="End date"
              type="date"
              variant="outlined"
              density="compact"
              prepend-inner-icon="event"
              hide-details
              class="pj-filter"
              @input="debouncedSearch"
            />
          </div>

          <div class="pj-filters__row mt-3">
            <v-select
              v-model="selectedJobStatuses"
              :items="availableJobStatuses"
              label="Job status"
              prepend-inner-icon="info"
              variant="outlined"
              density="compact"
              multiple
              chips
              clearable
              hide-details
              class="pj-filter"
            >
              <template #chip="{ item, props }">
                <v-chip
                  v-bind="props"
                  :color="getStatusColor(item.value)"
                  size="small"
                  closable
                >
                  {{ item.value }}
                </v-chip>
              </template>
            </v-select>

            <v-select
              v-model="selectedPrinterStates"
              :items="['Disabled', 'Maintenance', 'Offline', 'Error', 'Paused', 'Operational', 'Printing']"
              label="Printer state"
              prepend-inner-icon="settings"
              variant="outlined"
              density="compact"
              multiple
              chips
              clearable
              hide-details
              class="pj-filter"
            >
              <template #chip="{ item, props }">
                <v-chip v-bind="props" size="small" closable>
                  {{ item.value }}
                </v-chip>
              </template>
            </v-select>

            <v-select
              v-model="selectedMaterialTypes"
              :items="availableMaterialTypes"
              label="Material"
              prepend-inner-icon="fiber_manual_record"
              variant="outlined"
              density="compact"
              multiple
              chips
              clearable
              hide-details
              class="pj-filter"
            >
              <template #chip="{ item, props }">
                <v-chip v-bind="props" size="small" closable color="green">
                  {{ item.value }}
                </v-chip>
              </template>
            </v-select>

            <v-select
              v-model="selectedPrinterModels"
              :items="availablePrinterModels"
              label="Printer model"
              prepend-inner-icon="print"
              variant="outlined"
              density="compact"
              multiple
              chips
              clearable
              hide-details
              class="pj-filter"
            >
              <template #chip="{ item, props }">
                <v-chip v-bind="props" size="small" closable color="primary">
                  {{ item.value }}
                </v-chip>
              </template>
            </v-select>
          </div>

          <div
            v-if="activeFiltersCount > 0"
            class="pj-filters__footer"
          >
            <v-btn
              variant="text"
              size="x-small"
              prepend-icon="clear_all"
              @click="resetAdvancedFilters()"
            >
              Clear filters
            </v-btn>
          </div>
        </div>
      </v-expand-transition>
    </v-card>

    <!-- ─── Results: Jobs as tiles, Queue as table ───────────── -->
    <v-card elevation="1" class="pj-results">
      <v-card-title class="d-flex align-center py-2">
        <v-icon class="mr-2" color="primary" size="small">{{ activeTab === 'jobs' ? 'list_alt' : 'queue' }}</v-icon>
        <span class="text-subtitle-1">{{ activeTab === 'jobs' ? 'Results' : 'Queue' }}</span>
        <v-spacer/>

        <div v-if="activeTab === 'jobs' && !loading && totalJobs > 0" class="text-caption text-medium-emphasis">
          {{ ((currentPage - 1) * itemsPerPage) + 1 }}-{{ Math.min(currentPage * itemsPerPage, totalJobs) }} of
          {{ totalJobs }}
        </div>
        <div v-if="activeTab === 'queue' && !loadingQueue && queueCount > 0" class="text-caption text-medium-emphasis">
          {{ ((queueCurrentPage - 1) * queuePageSize) + 1 }}-{{
            Math.min(queueCurrentPage * queuePageSize, queueCount)
          }} of {{ queueCount }}
        </div>
      </v-card-title>

      <!-- ─── JOBS: row list ───────────────────────────────────── -->
      <template v-if="activeTab === 'jobs'">
        <!-- Loading skeletons -->
        <div v-if="loading" class="pj-list">
          <v-skeleton-loader
            v-for="n in 6"
            :key="n"
            type="list-item-avatar-two-line"
            class="pj-job-skeleton"
          />
        </div>

        <!-- Empty -->
        <div v-else-if="filteredPrintJobs.length === 0" class="text-center py-10">
          <v-icon size="48" color="grey-lighten-1" class="mb-3">work_off</v-icon>
          <h3 class="text-subtitle-1 mb-2">No Print Jobs Found</h3>
          <p class="text-body-2 text-medium-emphasis mb-3">
            Try adjusting your search criteria or date range
          </p>
          <v-btn color="primary" size="small" prepend-icon="clear_all" @click="clearFilters">
            Clear Filters
          </v-btn>
        </div>

        <!-- Rows -->
        <div v-else class="pj-list">
          <v-card
            v-for="job in filteredPrintJobs"
            :key="job.id"
            class="pj-row"
            elevation="0"
            @click="viewJobDetails(job)"
          >
            <span class="pj-row__accent" :style="jobAccentStyle(job)" />

            <FileThumbnailCell
              class="pj-row__thumb"
              :file-storage-id="job.fileStorageId"
              :thumbnails="job.thumbnails || []"
              @click.stop
            />

            <!-- Primary: file name + meta -->
            <div class="pj-row__main">
              <div class="pj-row__name text-truncate">
                <v-icon size="small" color="primary" class="flex-shrink-0">description</v-icon>
                <span class="text-truncate">{{ displayFileName(job) }}</span>
                <v-tooltip activator="parent" location="top" open-delay="400">{{ displayFileName(job) }}</v-tooltip>
              </div>
              <div class="pj-row__meta">
                <span class="pj-row__meta-item">
                  <v-icon size="14">print</v-icon>{{ job.printerName || `Printer ${ job.printerId }` }}
                </span>
                <span v-if="job.statistics?.actualPrintTimeSeconds" class="pj-row__meta-item">
                  <v-icon size="14">schedule</v-icon>{{ formatDuration(job.statistics.actualPrintTimeSeconds) }}
                </span>
                <span v-if="jobFilamentText(job)" class="pj-row__meta-item">
                  <v-icon size="14">fitness_center</v-icon>{{ jobFilamentText(job) }}
                </span>
                <span class="pj-row__meta-item pj-row__meta-item--muted">
                  <v-icon size="14">event</v-icon>{{ formatRelativeTime(job.createdAt) }}
                </span>
              </div>
            </div>

            <!-- Progress (rail always reserved so status chips stay aligned) -->
            <div class="pj-row__progress">
              <template v-if="showProgress(job)">
                <v-progress-linear
                  :model-value="job.progress ?? 0"
                  :color="getProgressColor(job.progress ?? 0)"
                  height="5"
                  rounded
                />
                <span class="text-caption text-medium-emphasis">{{ Math.round(job.progress ?? 0) }}%</span>
              </template>
            </div>

            <!-- Status + reason -->
            <div class="pj-row__status">
              <v-chip
                :color="getStatusColor(job.status)"
                :prepend-icon="getStatusIcon(job.status)"
                size="small"
                variant="flat"
                class="pj-row__chip"
              >
                {{ formatStatusLabel(job.status) }}
              </v-chip>
              <v-tooltip v-if="job.statusReason" location="top">
                <template #activator="{ props }">
                  <v-icon v-bind="props" color="warning" size="small">info</v-icon>
                </template>
                <span>{{ job.statusReason }}</span>
              </v-tooltip>
            </div>

            <!-- Actions -->
            <v-menu @click.stop>
              <template #activator="{ props }">
                <v-btn icon size="small" variant="text" class="pj-row__menu flex-shrink-0" v-bind="props" @click.stop>
                  <v-icon>more_vert</v-icon>
                </v-btn>
              </template>
              <v-list density="compact">
                <v-list-item prepend-icon="info" title="View Details" @click="viewJobDetails(job)" />
                <v-list-item prepend-icon="playlist_add" title="Add to Queue" :disabled="!canAddToQueue(job)" @click="handleAddToQueue(job)" />
                <v-list-item prepend-icon="send" title="Submit to Printer" :disabled="!canSubmitToPrinter(job)" @click="submitToPrinter(job)" />
                <v-divider />
                <v-list-item prepend-icon="refresh" title="Re-Analyze" :disabled="!canReAnalyzeJob(job)" @click="handleReAnalyzeJob(job)" />
                <v-list-item prepend-icon="check_circle" title="Mark as Completed" :disabled="!canMarkAsCompleted(job)" @click="handleMarkAsCompleted(job)" />
                <v-list-item prepend-icon="error" title="Mark as Failed" :disabled="!canMarkAsFailed(job)" @click="handleMarkAsFailed(job)" />
                <v-list-item prepend-icon="cancel" title="Mark as Cancelled" :disabled="!canMarkAsCancelled(job)" @click="handleMarkAsCancelled(job)" />
                <v-list-item prepend-icon="help" title="Mark as Unknown" :disabled="!canMarkAsUnknown(job)" @click="handleMarkAsUnknown(job)" />
                <v-divider />
                <v-list-item prepend-icon="delete" title="Delete Job" class="text-error" :disabled="!canDeleteJob(job)" @click="handleDeleteJob(job)" />
              </v-list>
            </v-menu>
          </v-card>
        </div>

        <!-- Pagination -->
        <template v-if="totalJobs > 0 && filteredPrintJobs.length > 0">
          <v-divider />
          <div class="pj-pager">
            <v-select
              v-model="itemsPerPage"
              :items="[12, 24, 48, 96]"
              density="compact"
              variant="outlined"
              hide-details
              class="pj-pager__size"
              @update:model-value="onItemsPerPageChange"
            />
            <v-pagination
              v-model="currentPage"
              :length="totalPages"
              :total-visible="5"
              density="comfortable"
              @update:model-value="loadPrintJobs"
            />
          </div>
        </template>
      </template>

      <!-- ─── QUEUE: table ─────────────────────────────────────── -->
      <v-card-text v-else class="pa-0">
        <v-data-table-server
          v-model:items-per-page="queuePageSize"
          v-model:page="queueCurrentPage"
          :headers="computedHeaders"
          :items="queueItems"
          :items-length="queueCount"
          :loading="loadingQueue"
          class="print-jobs-table"
          loading-text="Loading queue..."
          no-data-text="No jobs in queue"
          @update:options="loadQueue"
        >
          <template #item.queuePosition="{ item }">
            <v-chip size="small" color="info" variant="tonal">
              <v-icon start size="small">format_list_numbered</v-icon>
              Position {{ item.queuePosition }}
            </v-chip>
          </template>

          <template #item.status="{ item }">
            <v-chip :color="getQueueStatusColor(item.status)" size="small" variant="tonal">
              {{ formatStatusLabel(item.status) }}
            </v-chip>
          </template>

          <template #item.createdAt="{ item }">
            <div class="text-body-2">
              <div>{{ formatDate(item.createdAt) }}</div>
              <div class="text-caption text-medium-emphasis">{{ formatRelativeTime(item.createdAt) }}</div>
            </div>
          </template>

          <template #item.printerName="{ item }">
            <div class="d-flex align-center">
              <v-avatar size="24" class="mr-2" color="primary">
                <v-icon size="small">print</v-icon>
              </v-avatar>
              <div>
                <div class="text-body-2 font-weight-medium">{{ item.printerName || `Printer ${ item.printerId }` }}</div>
                <div class="text-caption text-medium-emphasis">ID: {{ item.printerId }}</div>
              </div>
            </div>
          </template>

          <template #item.fileName="{ item }">
            <div class="d-flex align-center file-cell">
              <v-icon class="mr-2 flex-shrink-0" size="small" color="primary">description</v-icon>
              <div class="file-cell__text">
                <div class="text-body-2 font-weight-medium file-cell__name">{{ displayFileName(item) }}</div>
                <div v-if="item.estimatedTimeSeconds" class="text-caption text-medium-emphasis">
                  Est. {{ formatDuration(item.estimatedTimeSeconds) }}
                </div>
              </div>
            </div>
          </template>

          <template #item.filament="{ item }">
            <div v-if="item.filamentGrams !== undefined && item.filamentGrams !== null" class="text-body-2">
              <v-chip color="purple" size="small" variant="tonal">
                <v-icon start size="small">science</v-icon>
                <template v-if="Array.isArray(item.filamentGrams)">
                  <span v-for="(val, idx) in item.filamentGrams" :key="idx">
                    {{ val != null ? val.toFixed(1) : '-' }}g<span v-if="Number(idx) < item.filamentGrams.length - 1">, </span>
                  </span>
                </template>
                <template v-else>{{ item.filamentGrams.toFixed(1) }}g</template>
              </v-chip>
            </div>
            <span v-else class="text-medium-emphasis">-</span>
          </template>

          <template #item.actions="{ item }">
            <v-btn icon="send" size="small" variant="text" color="success" @click="submitToPrinter(item)">
              <v-icon>send</v-icon>
              <v-tooltip activator="parent" location="top">Submit to printer</v-tooltip>
            </v-btn>
            <v-btn icon="delete" size="small" variant="text" color="error" @click="removeFromQueue(item.printerId, item.jobId)">
              <v-icon>delete</v-icon>
              <v-tooltip activator="parent" location="top">Remove from queue</v-tooltip>
            </v-btn>
          </template>

          <template #loading>
            <v-skeleton-loader type="table-row@5"/>
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>

    <!-- Mark as Completed Confirmation Dialog -->
    <v-dialog v-model="showCompleteConfirmDialog" max-width="500">
      <v-card>
        <v-card-title class="d-flex align-center bg-success text-on-success">
          <v-icon class="mr-3">check_circle</v-icon>
          <span>Mark Job as Completed?</span>
        </v-card-title>

        <v-card-text class="pt-4">
          <p class="text-body-1 mb-2">
            Are you sure you want to mark this print job as completed?
          </p>
          <v-alert type="info" density="compact" class="mb-2">
            <strong>Job:</strong> {{ displayFileName(jobToComplete) }}
          </v-alert>
          <p class="text-body-2 text-medium-emphasis">
            This will set the job status to COMPLETED and update the end time to now.
          </p>
        </v-card-text>

        <v-divider/>

        <v-card-actions>
          <v-spacer/>
          <v-btn
            variant="text"
            @click="cancelMarkAsCompleted"
            :disabled="completing"
          >
            Cancel
          </v-btn>
          <v-btn
            color="success"
            variant="elevated"
            @click="confirmMarkAsCompleted"
            :loading="completing"
          >
            Mark as Completed
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Mark as Failed Confirmation Dialog -->
    <v-dialog v-model="showFailedConfirmDialog" max-width="500">
      <v-card>
        <v-card-title class="d-flex align-center bg-error text-on-error">
          <v-icon class="mr-3">error</v-icon>
          <span>Mark Job as Failed?</span>
        </v-card-title>

        <v-card-text class="pt-4">
          <p class="text-body-1 mb-2">
            Are you sure you want to mark this print job as failed?
          </p>
          <v-alert type="info" density="compact" class="mb-2">
            <strong>Job:</strong> {{ displayFileName(jobToFail) }}
          </v-alert>
          <p class="text-body-2 text-medium-emphasis">
            This will set the job status to FAILED and update the end time to now.
          </p>
        </v-card-text>

        <v-divider/>

        <v-card-actions>
          <v-spacer/>
          <v-btn
            variant="text"
            @click="cancelMarkAsFailed"
            :disabled="failing"
          >
            Cancel
          </v-btn>
          <v-btn
            color="error"
            variant="elevated"
            @click="confirmMarkAsFailed"
            :loading="failing"
          >
            Mark as Failed
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Mark as Cancelled Confirmation Dialog -->
    <v-dialog v-model="showCancelledConfirmDialog" max-width="500">
      <v-card>
        <v-card-title class="d-flex align-center bg-warning text-on-warning">
          <v-icon class="mr-3">cancel</v-icon>
          <span>Mark Job as Cancelled?</span>
        </v-card-title>

        <v-card-text class="pt-4">
          <p class="text-body-1 mb-2">
            Are you sure you want to mark this print job as cancelled?
          </p>
          <v-alert type="info" density="compact" class="mb-2">
            <strong>Job:</strong> {{ displayFileName(jobToCancel) }}
          </v-alert>
          <p class="text-body-2 text-medium-emphasis">
            This will set the job status to CANCELLED and update the end time to now.
          </p>
        </v-card-text>

        <v-divider/>

        <v-card-actions>
          <v-spacer/>
          <v-btn
            variant="text"
            @click="cancelMarkAsCancelled"
            :disabled="cancelling"
          >
            Cancel
          </v-btn>
          <v-btn
            color="warning"
            variant="elevated"
            @click="confirmMarkAsCancelled"
            :loading="cancelling"
          >
            Mark as Cancelled
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Mark as Unknown Confirmation Dialog -->
    <v-dialog v-model="showUnknownConfirmDialog" max-width="500">
      <v-card>
        <v-card-title class="d-flex align-center bg-grey text-on-grey">
          <v-icon class="mr-3">help</v-icon>
          <span>Mark Job as Unknown?</span>
        </v-card-title>

        <v-card-text class="pt-4">
          <p class="text-body-1 mb-2">
            Are you sure you want to mark this print job status as unknown?
          </p>
          <v-alert type="info" density="compact" class="mb-2">
            <strong>Job:</strong> {{ displayFileName(jobToSetUnknown) }}
          </v-alert>
          <p class="text-body-2 text-medium-emphasis">
            This will set the job status to UNKNOWN.
          </p>
        </v-card-text>

        <v-divider/>

        <v-card-actions>
          <v-spacer/>
          <v-btn
            variant="text"
            @click="cancelMarkAsUnknown"
            :disabled="settingUnknown"
          >
            Cancel
          </v-btn>
          <v-btn
            color="grey"
            variant="elevated"
            @click="confirmMarkAsUnknown"
            :loading="settingUnknown"
          >
            Mark as Unknown
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Add to Queue Dialog -->
    <v-dialog v-model="showAddToQueueDialog" max-width="600">
      <v-card>
        <v-card-title class="d-flex align-center bg-primary text-on-primary">
          <v-icon class="mr-3">playlist_add</v-icon>
          <span>Add Job to Queue</span>
        </v-card-title>

        <v-card-text class="pt-4">
          <p class="text-body-1 mb-3">
            Select which printer(s) should queue this job:
          </p>
          <v-alert type="info" density="compact" class="mb-3">
            <strong>Job:</strong> {{ displayFileName(jobToQueue) }}
          </v-alert>

          <!-- Printer Selection -->
          <v-select
            v-model="selectedPrintersForQueue"
            :items="availablePrinters"
            item-title="name"
            item-value="id"
            label="Select Printer(s)"
            multiple
            chips
            prepend-inner-icon="print"
            variant="outlined"
            density="comfortable"
            hint="You can select multiple printers"
            persistent-hint
          >
            <template #chip="{ item, props }">
              <v-chip v-bind="props" color="primary" closable>
                {{ item.title }}
              </v-chip>
            </template>
          </v-select>
        </v-card-text>

        <v-divider/>

        <v-card-actions>
          <v-spacer/>
          <v-btn
            variant="text"
            @click="cancelAddToQueue"
            :disabled="addingToQueue"
          >
            Cancel
          </v-btn>
          <v-btn
            color="primary"
            variant="elevated"
            @click="confirmAddToQueue"
            :loading="addingToQueue"
            :disabled="selectedPrintersForQueue.length === 0"
          >
            Add to Queue ({{ selectedPrintersForQueue.length }})
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Delete Confirmation Dialog -->
    <v-dialog v-model="showDeleteConfirmDialog" max-width="500">
      <v-card>
        <v-card-title class="d-flex align-center bg-error text-on-error">
          <v-icon class="mr-3">warning</v-icon>
          <span>Delete Print Job?</span>
        </v-card-title>

        <v-card-text class="pt-4">
          <p class="text-body-1 mb-2">
            Are you sure you want to delete this print job?
          </p>
          <v-alert type="info" density="compact" class="mb-2">
            <strong>Job:</strong> {{ displayFileName(jobToDelete) }}
          </v-alert>

          <v-checkbox
            v-if="jobToDelete?.fileStorageId"
            v-model="deleteFileWithJob"
            label="Also delete the file from storage"
            color="error"
            density="compact"
            hide-details
            class="mb-2"
          >
            <template #label>
              <div class="text-body-2">
                Also delete the file from storage
                <div class="text-caption text-medium-emphasis">
                  (File will only be deleted if not used by other jobs)
                </div>
              </div>
            </template>
          </v-checkbox>

          <p class="text-body-2 text-medium-emphasis">
            This action cannot be undone. All job data and metadata will be permanently removed.
          </p>
        </v-card-text>

        <v-divider/>

        <v-card-actions>
          <v-spacer/>
          <v-btn
            variant="text"
            @click="cancelDelete"
            :disabled="deleting"
          >
            Cancel
          </v-btn>
          <v-btn
            color="error"
            variant="elevated"
            @click="confirmDeleteJob"
            :loading="deleting"
          >
            Delete Job
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Submit to Printer Dialog -->
    <v-dialog v-model="showSubmitToPrinterDialog" max-width="500">
      <v-card>
        <v-card-title class="d-flex align-center bg-success text-on-success">
          <v-icon class="mr-3">print</v-icon>
          <span>Submit Job to Printer</span>
        </v-card-title>

        <v-card-text class="pt-4">
          <p class="text-body-1 mb-2">
            Select the printer you want to submit this job to:
          </p>
          <v-alert type="info" density="compact" class="mb-2">
            <strong>Job:</strong> {{ displayFileName(jobToSubmit) }}
          </v-alert>

          <!-- Printer Selection -->
          <v-select
            v-model="selectedPrinterForSubmit"
            :items="availablePrinters"
            item-title="name"
            item-value="id"
            label="Select Printer"
            prepend-inner-icon="print"
            variant="outlined"
            density="comfortable"
          />
        </v-card-text>

        <v-divider/>

        <v-card-actions>
          <v-spacer/>
          <v-btn
            variant="text"
            @click="cancelSubmitToPrinter"
            :disabled="submitting"
          >
            Cancel
          </v-btn>
          <v-btn
            color="success"
            variant="elevated"
            @click="confirmSubmitToPrinter"
            :loading="submitting"
            :disabled="!selectedPrinterForSubmit"
          >
            Submit to Printer
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script lang="ts" setup>
import { onMounted, ref, computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import { PrintJobService, type PrintJobDto, type PrintJobSearchPagedParams } from '@/backend/print-job.service'
import { PrintQueueService } from '@/backend/print-queue.service'
import { useDebounceFn } from '@vueuse/core'
import { displayFileName } from '@/utils/file-name.util'
import { useOnPrintJobsChanged } from '@/shared/print-jobs-invalidator.composable'
import { usePrinterStore } from '@/store/printer.store'
import { usePrinterStateStore } from '@/store/printer-state.store'
import { usePrinterFilters } from '@/shared/printer-filter.composable'
import { interpretStates } from '@/shared/printer-state.constants'
import { useSnackbar } from '@/shared/snackbar.composable'
import { useDialog } from '@/shared/dialog.composable'
import { DialogName } from '@/components/Generic/Dialogs/dialog.constants'
import { formatDate, formatRelativeTime, formatDuration } from '@/utils/date-time.utils'

const route = useRoute()

// Tab state
const activeTab = ref('jobs')

// Watch for tab changes to load queue data
watch(activeTab, (newTab) => {
  if (newTab === 'queue') {
    loadQueue()
  }
})

// Jobs tab state
const printJobs = ref<PrintJobDto[]>([])
const loading = ref(false)
const currentPage = ref(1)
const itemsPerPage = ref(24)
const totalJobs = ref(0)

// Queue tab state
const queueItems = ref<any[]>([])
const loadingQueue = ref(false)
const queueCurrentPage = ref(1)
const queuePageSize = ref(50)
const queueCount = ref(0)

// Snackbar for notifications
const { info, error } = useSnackbar()

const printerStore = usePrinterStore()
const printerStateStore = usePrinterStateStore()

// Dialog composables
const jobDetailsDialog = useDialog(DialogName.PrintJobDetailsDialog)

// Delete confirmation
const showDeleteConfirmDialog = ref(false)
const jobToDelete = ref<PrintJobDto | null>(null)
const deleting = ref(false)
const deleteFileWithJob = ref(false)

// Mark as completed confirmation
const showCompleteConfirmDialog = ref(false)
const jobToComplete = ref<PrintJobDto | null>(null)
const completing = ref(false)

// Mark as failed confirmation
const showFailedConfirmDialog = ref(false)
const jobToFail = ref<PrintJobDto | null>(null)
const failing = ref(false)

// Mark as cancelled confirmation
const showCancelledConfirmDialog = ref(false)
const jobToCancel = ref<PrintJobDto | null>(null)
const cancelling = ref(false)

// Mark as unknown confirmation
const showUnknownConfirmDialog = ref(false)
const jobToSetUnknown = ref<PrintJobDto | null>(null)
const settingUnknown = ref(false)

// Add to queue confirmation
const showAddToQueueDialog = ref(false)
const jobToQueue = ref<PrintJobDto | null>(null)
const selectedPrintersForQueue = ref<number[]>([])
const addingToQueue = ref(false)

// Submit to printer confirmation
const showSubmitToPrinterDialog = ref(false)
const jobToSubmit = ref<any | null>(null)
const selectedPrinterForSubmit = ref<number | null>(null)
const submitting = ref(false)

const { loadTags } = usePrinterFilters()

// Additional filter selections
const selectedPrinterIds = ref<number[]>([])
const selectedJobStatuses = ref<string[]>([])
const selectedPrinterStates = ref<string[]>([])
const selectedMaterialTypes = ref<string[]>([])
const selectedPrinterModels = ref<string[]>([])

// Advanced-filters UI state
const showAdvancedFilters = ref(false)

const activeFiltersCount = computed(() => {
  let count = 0
  if (selectedJobStatuses.value.length) count++
  if (selectedPrinterStates.value.length) count++
  if (selectedMaterialTypes.value.length) count++
  if (selectedPrinterModels.value.length) count++
  if (searchParams.value.startDate && searchParams.value.startDate !== lastWeek.toISOString().split('T')[0]) count++
  if (searchParams.value.endDate && searchParams.value.endDate !== today.toISOString().split('T')[0]) count++
  return count
})

function resetAdvancedFilters() {
  selectedJobStatuses.value = []
  selectedPrinterStates.value = []
  selectedMaterialTypes.value = []
  selectedPrinterModels.value = []
  searchParams.value.startDate = lastWeek.toISOString().split('T')[0]
  searchParams.value.endDate = today.toISOString().split('T')[0]
  debouncedSearch()
}

// Calculate default date range: last week to today
const today = new Date()
const lastWeek = new Date(today)
lastWeek.setDate(lastWeek.getDate() - 7)

const searchParams = ref<PrintJobSearchPagedParams>({
  searchPrinter: '',
  searchFile: '',
  startDate: lastWeek.toISOString().split('T')[0], // Format: YYYY-MM-DD
  endDate: today.toISOString().split('T')[0], // Format: YYYY-MM-DD
  page: 1,
  pageSize: 25
})

// Unique values for filters
const availableJobStatuses = computed(() => {
  const statuses = new Set<string>()
  printJobs.value.forEach(job => {
    if (job.status) statuses.add(job.status)
  })
  return Array.from(statuses).sort()
})

const availableMaterialTypes = computed(() => {
  const materials = new Set<string>()
  printJobs.value.forEach(job => {
    if (job.metadata?.filamentType) materials.add(job.metadata.filamentType)
  })
  return Array.from(materials).sort()
})

const availablePrinterModels = computed(() => {
  const models = new Set<string>()
  printJobs.value.forEach(job => {
    if (job.metadata?.printerModel) models.add(job.metadata.printerModel)
  })
  return Array.from(models).sort()
})

// Get printer state for a job
const getPrinterState = (printerId: number | null): string => {
  if (!printerId) return 'Unknown'
  const printer = printerStore.printers.find(p => p.id === printerId)
  if (!printer) return 'Unknown'

  const socketState = printerStateStore.socketStatesById[printerId]
  const printerState = printerStateStore.printerEventsById[printerId]

  if (!socketState || !printerState) return 'Unknown'

  const interpreted = interpretStates(printer, socketState, printerState)
  return interpreted?.text || 'Unknown'
}

const filteredPrintJobs = computed(() => {
  let filtered = printJobs.value

  // Filter by selected printers
  if (selectedPrinterIds.value.length > 0) {
    filtered = filtered.filter(job => {
      return job.printerId && selectedPrinterIds.value.includes(job.printerId)
    })
  }

  // Filter by job status
  if (selectedJobStatuses.value.length > 0) {
    filtered = filtered.filter(job => {
      return selectedJobStatuses.value.includes(job.status)
    })
  }

  // Filter by printer state
  if (selectedPrinterStates.value.length > 0) {
    filtered = filtered.filter(job => {
      const state = getPrinterState(job.printerId)
      return selectedPrinterStates.value.includes(state)
    })
  }

  // Filter by material type
  if (selectedMaterialTypes.value.length > 0) {
    filtered = filtered.filter(job => {
      return job.metadata?.filamentType && selectedMaterialTypes.value.includes(job.metadata.filamentType)
    })
  }

  // Filter by printer model
  if (selectedPrinterModels.value.length > 0) {
    filtered = filtered.filter(job => {
      return job.metadata?.printerModel && selectedPrinterModels.value.includes(job.metadata.printerModel)
    })
  }

  return filtered
})

// Queue tab still renders as a table; the Jobs tab uses the tile grid.
const computedHeaders = computed(() => [
  { title: 'Position', key: 'queuePosition', sortable: false },
  { title: 'Printer', key: 'printerName', sortable: false },
  { title: 'File Name', key: 'fileName', sortable: false },
  { title: 'Status', key: 'status', sortable: false },
  { title: 'Queued At', key: 'createdAt', sortable: false },
  { title: 'Filament', key: 'filament', sortable: false },
  { title: 'Actions', key: 'actions', sortable: false, align: 'center' as const }
])

const totalPages = computed(() => Math.max(1, Math.ceil(totalJobs.value / itemsPerPage.value)))

const onItemsPerPageChange = () => {
  currentPage.value = 1
  loadPrintJobs()
}

const debouncedSearch = useDebounceFn(() => {
  currentPage.value = 1
  loadPrintJobs()
}, 500)

// Reload the list whenever a job is mutated anywhere in the app — pause,
// cancel, resume from the drawer/tile, set-completed/failed from this view,
// or a socket-driven state transition (handled by the completion watcher).
useOnPrintJobsChanged(async () => {
  // Re-run the same search the user is looking at so filters/sort stay
  // applied. Catch errors silently — a failed refresh shouldn't trigger
  // a snackbar on top of whatever the user just did.
  try {
    if (activeTab.value === 'jobs') {
      await loadPrintJobs()
    } else {
      await loadQueue()
    }
  } catch (err) {
    console.warn('[PrintJobs] failed to refresh after change signal:', err)
  }
})

onMounted(async () => {
  // Load printers first
  await printerStore.loadPrinters()

  // Check for printerId query parameter and auto-select
  const printerIdParam = route.query.printerId
  if (printerIdParam) {
    const printerId = Number(printerIdParam)
    selectedPrinterIds.value = [printerId]
  }

  await loadPrintJobs()
  await loadTags()
})

const loadPrintJobs = async () => {
  console.debug('[LoadJobs] loadPrintJobs called, loading state:', loading.value)

  // Prevent concurrent calls
  if (loading.value) {
    console.debug('[LoadJobs] Already loading, skipping...')
    return
  }

  loading.value = true
  try {
    const params: PrintJobSearchPagedParams = {
      ...searchParams.value,
      page: currentPage.value,
      pageSize: itemsPerPage.value
    }

    // Remove empty strings to avoid sending unnecessary parameters
    Object.keys(params).forEach(key => {
      if (params[key as keyof PrintJobSearchPagedParams] === '') {
        delete params[key as keyof PrintJobSearchPagedParams]
      }
    })

    console.debug('[LoadJobs] Fetching jobs with params:', params)
    const response = await PrintJobService.searchJobsPaged(params)
    printJobs.value = response.items
    totalJobs.value = response.count
    console.debug('[LoadJobs] Received', response.items.length, 'jobs')
  } catch (error) {
    console.error('Failed to load print jobs:', error)
    printJobs.value = []
    totalJobs.value = 0
  } finally {
    loading.value = false
  }
}

// Queue functions
const loadQueue = async () => {
  loadingQueue.value = true
  try {
    const response = await PrintQueueService.getGlobalQueue(queueCurrentPage.value, queuePageSize.value)
    queueItems.value = response.items
    queueCount.value = response.totalCount
  } catch (error) {
    console.error('Failed to load queue:', error)
    queueItems.value = []
    queueCount.value = 0
  } finally {
    loadingQueue.value = false
  }
}

const removeFromQueue = async (printerId: number, jobId: number) => {
  try {
    await PrintQueueService.removeFromQueue(printerId, jobId)
    info('Removed from Queue', 'Job removed from queue successfully')
    await loadQueue()
  } catch (err: any) {
    console.error('Failed to remove from queue:', err)
    error('Remove Failed', err?.response?.data?.message || 'Failed to remove job from queue')
  }
}

const getQueueStatusColor = (status: string) => {
  const colors: Record<string, string> = {
    'QUEUED': 'info',
    'PENDING': 'warning',
    'STARTING': 'primary',
    'PRINTING': 'success',
    'COMPLETED': 'success',
    'FAILED': 'error',
    'CANCELLED': 'warning'
  }
  return colors[status] || 'default'
}

// Human-readable label for status enum values. Anything not in the map
// falls through unchanged so an unexpected enum from the backend (e.g.
// added later) is still visible instead of becoming "Unknown".
const friendlyStatusLabel: Record<string, string> = {
  PENDING: 'Pending',
  QUEUED: 'Queued',
  STARTING: 'Transferring…',
  PRINTING: 'Printing',
  PAUSED: 'Paused',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  UNKNOWN: 'Unknown'
}
const formatStatusLabel = (status: string | null | undefined): string => {
  if (!status) return 'Unknown'
  return friendlyStatusLabel[status] ?? status
}

const getStatusColor = (status: string | null): string => {
  switch (status) {
    case 'COMPLETED':
      return 'success'
    case 'FAILED':
      return 'error'
    case 'CANCELLED':
      return 'warning'
    case 'PRINTING':
    case 'STARTING':
      return 'primary'
    case 'PAUSED':
      return 'orange'
    case 'ANALYZING':
    case 'ANALYZED':
    case 'QUEUED':
      return 'info'
    case 'PENDING':
      return 'grey-darken-1'
    case 'UNKNOWN':
      return 'grey'
    default:
      return 'grey'
  }
}

const getStatusIcon = (status: string | null): string => {
  switch (status) {
    case 'COMPLETED':
      return 'check_circle'
    case 'FAILED':
      return 'error'
    case 'CANCELLED':
      return 'cancel'
    case 'PRINTING':
      return 'play_circle'
    case 'STARTING':
      return 'play_arrow'
    case 'PAUSED':
      return 'pause_circle'
    case 'QUEUED':
      return 'queue'
    case 'PENDING':
      return 'schedule'
    case 'UNKNOWN':
      return 'help_outline'
    default:
      return 'help'
  }
}

// Show the inline progress bar for jobs that have a meaningful in-flight or
// interrupted progress value. Completed jobs are implicitly 100%, so the bar
// would be redundant noise next to the "Completed" chip.
const showProgress = (job: PrintJobDto): boolean => {
  return job.progress !== null && job.progress !== undefined && job.status !== 'COMPLETED'
}

const getProgressColor = (progress: number): string => {
  if (progress >= 90) return 'success'
  if (progress >= 50) return 'primary'
  if (progress >= 25) return 'warning'
  return 'error'
}

// Theme tokens only (so `rgb(var(--v-theme-*))` resolves) for the tile's
// left accent stripe. Returns undefined for unknown states so the CSS
// fallback colour applies.
const jobAccentVar = (status: string | null): string | undefined => {
  switch (status) {
    case 'COMPLETED': return 'success'
    case 'FAILED': return 'error'
    case 'CANCELLED':
    case 'PAUSED': return 'warning'
    case 'PRINTING':
    case 'STARTING': return 'primary'
    case 'QUEUED':
    case 'ANALYZING':
    case 'ANALYZED': return 'info'
    default: return undefined
  }
}

const jobAccentStyle = (job: PrintJobDto): Record<string, string> => {
  const token = jobAccentVar(job.status)
  return token ? { '--state-color': `rgb(var(--v-theme-${token}))` } : {}
}

// Compact filament summary for the tile meta line, handling both the
// single-extruder number and the multi-tool (MMU/XL) array shape.
const jobFilamentText = (job: PrintJobDto): string | null => {
  const grams = job.metadata?.filamentUsedGrams as number | number[] | null | undefined
  if (grams === undefined || grams === null) return null
  if (Array.isArray(grams)) {
    return grams.map(v => (v != null ? Math.round(v) : '-')).join(', ') + 'g'
  }
  return Math.round(grams) + 'g'
}

const clearFilters = () => {
  searchParams.value = {
    searchPrinter: '',
    searchFile: '',
    startDate: '',
    endDate: '',
    page: 1,
    pageSize: 25
  }
  selectedPrinterIds.value = []
  selectedJobStatuses.value = []
  selectedPrinterStates.value = []
  selectedMaterialTypes.value = []
  selectedPrinterModels.value = []
  currentPage.value = 1
  loadPrintJobs()
}

const viewJobDetails = (job: PrintJobDto) => {
  jobDetailsDialog.openDialog({ jobId: job.id })
}

// All printers for filter selection
const allPrinters = computed(() => {
  return printerStore.printers
})

// Available printers for queue selection (only enabled)
const availablePrinters = computed(() => {
  return printerStore.printers.filter(p => p.enabled)
})

// Note: Job updates/deletes will be handled by the dialog itself
// We just need to reload the jobs list when the dialog closes
// This can be done by watching for dialog close events or manually refreshing

const canAddToQueue = (job: PrintJobDto): boolean => {
  // Allow adding to queue for completed jobs
  return job.status === 'COMPLETED'
}

const canReAnalyzeJob = (job: PrintJobDto): boolean => {
  // Allow re-analysis for jobs that are not currently printing or starting
  return job.status !== 'PRINTING' && job.status !== 'STARTING'
}

const canMarkAsCompleted = (job: PrintJobDto): boolean => {
  // Allow marking as completed for jobs that are printing, paused, failed, cancelled, or unknown
  return job.status === 'PRINTING' ||
    job.status === 'PAUSED' ||
    job.status === 'FAILED' ||
    job.status === 'CANCELLED' ||
    job.status === 'UNKNOWN'
}

const canMarkAsFailed = (job: PrintJobDto): boolean => {
  // Allow marking as failed for jobs that are printing, paused, or completed
  return job.status === 'PRINTING' ||
    job.status === 'PAUSED' ||
    job.status === 'COMPLETED' ||
    job.status === 'CANCELLED' ||
    job.status === 'UNKNOWN'
}

const canMarkAsCancelled = (job: PrintJobDto): boolean => {
  // Allow marking as cancelled for jobs that are printing, paused, or completed
  return job.status === 'PRINTING' ||
    job.status === 'PAUSED' ||
    job.status === 'COMPLETED' ||
    job.status === 'FAILED' ||
    job.status === 'UNKNOWN'
}

const canMarkAsUnknown = (job: PrintJobDto): boolean => {
  // Allow marking as unknown for any job that has a definitive status
  return job.status === 'PRINTING' ||
    job.status === 'PAUSED' ||
    job.status === 'COMPLETED' ||
    job.status === 'FAILED' ||
    job.status === 'CANCELLED'
}

const canDeleteJob = (job: PrintJobDto): boolean => {
  // Allow deletion for jobs that are not currently printing
  return job.status !== 'PRINTING' && job.status !== 'STARTING'
}

const canSubmitToPrinter = (job: PrintJobDto): boolean => {
  // Allow submitting completed, failed, or cancelled jobs
  return job.status === 'COMPLETED' || job.status === 'FAILED' || job.status === 'CANCELLED'
}

const handleReAnalyzeJob = async (job: PrintJobDto) => {
  try {
    const updatedJob = await PrintJobService.reAnalyzeJob(job.id)

    // Update the job in the list
    const index = printJobs.value.findIndex(j => j.id === job.id)
    if (index !== -1) {
      printJobs.value[index] = updatedJob
    }

    info(
      'Job Re-Analysis Started',
      `Re-analysis triggered for "${ displayFileName(job) }". The job will be analyzed in the background.`,
      5000
    )
  } catch (err: any) {
    console.error('Failed to re-analyze job:', err)
    error(
      'Re-Analysis Failed',
      err?.response?.data?.message || err?.message || 'Failed to trigger job re-analysis. Please try again.'
    )
  }
}

const handleMarkAsCompleted = (job: PrintJobDto) => {
  jobToComplete.value = job
  showCompleteConfirmDialog.value = true
}

const confirmMarkAsCompleted = async () => {
  if (!jobToComplete.value) return

  completing.value = true
  try {
    const updatedJob = await PrintJobService.setJobCompleted(jobToComplete.value.id)

    // Update the job in the list
    const index = printJobs.value.findIndex(j => j.id === jobToComplete.value!.id)
    if (index !== -1) {
      printJobs.value[index] = updatedJob
    }

    info(
      'Job Marked as Completed',
      `Successfully marked "${ displayFileName(jobToComplete.value) }" as completed.`,
      3000
    )

    showCompleteConfirmDialog.value = false
    jobToComplete.value = null
  } catch (err: any) {
    console.error('Failed to mark job as completed:', err)
    error(
      'Mark as Completed Failed',
      err?.response?.data?.message || err?.message || 'Failed to mark job as completed. Please try again.'
    )
  } finally {
    completing.value = false
  }
}

const cancelMarkAsCompleted = () => {
  showCompleteConfirmDialog.value = false
  jobToComplete.value = null
}

const handleMarkAsFailed = (job: PrintJobDto) => {
  jobToFail.value = job
  showFailedConfirmDialog.value = true
}

const confirmMarkAsFailed = async () => {
  if (!jobToFail.value) return

  failing.value = true
  try {
    const updatedJob = await PrintJobService.setJobFailed(jobToFail.value.id)

    // Update the job in the list
    const index = printJobs.value.findIndex(j => j.id === jobToFail.value!.id)
    if (index !== -1) {
      printJobs.value[index] = updatedJob
    }

    info(
      'Job Marked as Failed',
      `Successfully marked "${ displayFileName(jobToFail.value) }" as failed.`,
      3000
    )

    showFailedConfirmDialog.value = false
    jobToFail.value = null
  } catch (err: any) {
    console.error('Failed to mark job as failed:', err)
    error(
      'Mark as Failed Failed',
      err?.response?.data?.message || err?.message || 'Failed to mark job as failed. Please try again.'
    )
  } finally {
    failing.value = false
  }
}

const cancelMarkAsFailed = () => {
  showFailedConfirmDialog.value = false
  jobToFail.value = null
}

const handleMarkAsCancelled = (job: PrintJobDto) => {
  jobToCancel.value = job
  showCancelledConfirmDialog.value = true
}

const confirmMarkAsCancelled = async () => {
  if (!jobToCancel.value) return

  cancelling.value = true
  try {
    const updatedJob = await PrintJobService.setJobCancelled(jobToCancel.value.id)

    // Update the job in the list
    const index = printJobs.value.findIndex(j => j.id === jobToCancel.value!.id)
    if (index !== -1) {
      printJobs.value[index] = updatedJob
    }

    info(
      'Job Marked as Cancelled',
      `Successfully marked "${ displayFileName(jobToCancel.value) }" as cancelled.`,
      3000
    )

    showCancelledConfirmDialog.value = false
    jobToCancel.value = null
  } catch (err: any) {
    console.error('Failed to mark job as cancelled:', err)
    error(
      'Mark as Cancelled Failed',
      err?.response?.data?.message || err?.message || 'Failed to mark job as cancelled. Please try again.'
    )
  } finally {
    cancelling.value = false
  }
}

const cancelMarkAsCancelled = () => {
  showCancelledConfirmDialog.value = false
  jobToCancel.value = null
}

const handleMarkAsUnknown = (job: PrintJobDto) => {
  jobToSetUnknown.value = job
  showUnknownConfirmDialog.value = true
}

const confirmMarkAsUnknown = async () => {
  if (!jobToSetUnknown.value) return

  settingUnknown.value = true
  try {
    const updatedJob = await PrintJobService.setJobUnknown(jobToSetUnknown.value.id)

    // Update the job in the list
    const index = printJobs.value.findIndex(j => j.id === jobToSetUnknown.value!.id)
    if (index !== -1) {
      printJobs.value[index] = updatedJob
    }

    info(
      'Job Marked as Unknown',
      `Successfully marked "${ displayFileName(jobToSetUnknown.value) }" as unknown.`,
      3000
    )

    showUnknownConfirmDialog.value = false
    jobToSetUnknown.value = null
  } catch (err: any) {
    console.error('Failed to mark job as unknown:', err)
    error(
      'Mark as Unknown Failed',
      err?.response?.data?.message || err?.message || 'Failed to mark job as unknown. Please try again.'
    )
  } finally {
    settingUnknown.value = false
  }
}

const cancelMarkAsUnknown = () => {
  showUnknownConfirmDialog.value = false
  jobToSetUnknown.value = null
}

const handleDeleteJob = (job: PrintJobDto) => {
  jobToDelete.value = job
  deleteFileWithJob.value = false
  showDeleteConfirmDialog.value = true
}

const confirmDeleteJob = async () => {
  if (!jobToDelete.value) return

  deleting.value = true
  try {
    const response = await PrintJobService.deleteJob(jobToDelete.value.id, deleteFileWithJob.value)

    // Remove the job from the list
    const index = printJobs.value.findIndex(j => j.id === jobToDelete.value!.id)
    if (index !== -1) {
      printJobs.value.splice(index, 1)
      totalJobs.value--
    }

    // Show appropriate message based on response
    let message = `Successfully deleted job "${ displayFileName(jobToDelete.value) }".`
    if (response?.fileDeleted) {
      message += ' File was also deleted from storage.'
    } else if (response?.remainingReferences) {
      message += ` File kept (used by ${ response.remainingReferences } other job${ response.remainingReferences > 1 ? 's' : '' }).`
    } else if (deleteFileWithJob.value && !response?.fileDeleted) {
      message += ' File was kept (no other jobs reference it).'
    }

    info(
      'Job Deleted',
      message,
      4000
    )

    showDeleteConfirmDialog.value = false
    jobToDelete.value = null
    deleteFileWithJob.value = false
  } catch (err: any) {
    console.error('Failed to delete job:', err)
    error(
      'Delete Failed',
      err?.response?.data?.message || err?.message || 'Failed to delete job. Please try again.'
    )
  } finally {
    deleting.value = false
  }
}

const cancelDelete = () => {
  showDeleteConfirmDialog.value = false
  jobToDelete.value = null
  deleteFileWithJob.value = false
}

const handleAddToQueue = (job: PrintJobDto) => {
  jobToQueue.value = job
  selectedPrintersForQueue.value = []
  showAddToQueueDialog.value = true
}

const confirmAddToQueue = async () => {
  if (!jobToQueue.value || selectedPrintersForQueue.value.length === 0) return

  addingToQueue.value = true
  try {
    // Add the job to queue for each selected printer
    for (const printerId of selectedPrintersForQueue.value) {
      await PrintQueueService.addToQueue(printerId, jobToQueue.value.id)
    }

    info(
      'Job Added to Queue',
      `Successfully added "${ displayFileName(jobToQueue.value) }" to ${ selectedPrintersForQueue.value.length } printer queue(s).`,
      3000
    )

    showAddToQueueDialog.value = false
    jobToQueue.value = null
    selectedPrintersForQueue.value = []
  } catch (err: any) {
    console.error('Failed to add job to queue:', err)
    error(
      'Add to Queue Failed',
      err?.response?.data?.message || err?.message || 'Failed to add job to queue. Please try again.'
    )
  } finally {
    addingToQueue.value = false
  }
}

const cancelAddToQueue = () => {
  showAddToQueueDialog.value = false
  jobToQueue.value = null
  selectedPrintersForQueue.value = []
}

const submitToPrinter = (job: PrintJobDto) => {
  jobToSubmit.value = job
  showSubmitToPrinterDialog.value = true
}

const confirmSubmitToPrinter = async () => {
  if (!jobToSubmit.value || !selectedPrinterForSubmit.value) return

  submitting.value = true
  try {
    // Submit the job to the selected printer
    await PrintQueueService.submitToPrinter(jobToSubmit.value.jobId, selectedPrinterForSubmit.value)

    info(
      'Job Submitted to Printer',
      `Successfully submitted "${ displayFileName(jobToSubmit.value) }" to the printer.`,
      3000
    )

    showSubmitToPrinterDialog.value = false
    jobToSubmit.value = null
    selectedPrinterForSubmit.value = null
  } catch (err: any) {
    console.error('Failed to submit job to printer:', err)
    error(
      'Submit to Printer Failed',
      err?.response?.data?.message || err?.message || 'Failed to submit job to printer. Please try again.'
    )
  } finally {
    submitting.value = false
  }
}

const cancelSubmitToPrinter = () => {
  showSubmitToPrinterDialog.value = false
  jobToSubmit.value = null
  selectedPrinterForSubmit.value = null
}
</script>

<style scoped>
.print-jobs-container {
  max-width: 100%;
}

.print-jobs-table {
  border-radius: 8px !important;
}

/* ─── Header (tabs + actions) ────────────────────────────────── */
.pj-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding-bottom: 0;
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}

.pj-tabs {
  flex: 0 0 auto;
}

/* ─── Filters card ───────────────────────────────────────────── */
.pj-filters {
  padding: 12px 16px;
  margin-bottom: 16px;
  background: rgb(var(--v-theme-surface));
}

.pj-filters__row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-start;
}

.pj-filter {
  flex: 1 1 200px;
  min-width: 180px;
  max-width: 340px;
}

.pj-filter--wide {
  flex: 1 1 300px;
  min-width: 240px;
  max-width: none;
}

.pj-filters__advanced {
  padding-top: 12px;
}

.pj-filters__footer {
  display: flex;
  justify-content: flex-end;
  padding-top: 8px;
}

.file-cell {
  max-width: 320px;
}

.file-cell__text {
  min-width: 0;
}

.file-cell__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ─── Job rows (Jobs tab) ────────────────────────────────────── */
.pj-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
}

.pj-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 8px 10px 8px 16px;
  background: rgb(var(--v-theme-surface));
  color: rgb(var(--v-theme-on-surface));
  border: 1px solid rgba(var(--v-theme-on-surface), 0.06);
  cursor: pointer;
  overflow: hidden;
  transition: background 0.15s ease;
}

.pj-row:hover {
  background: rgba(var(--v-theme-primary), 0.04);
}

.pj-row__accent {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 4px;
  background: var(--state-color, rgba(var(--v-theme-on-surface), 0.12));
}

.pj-row__thumb {
  flex: 0 0 auto;
}

.pj-row__main {
  flex: 1 1 auto;
  min-width: 0;
}

.pj-row__name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
}

.pj-row__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 12px;
  margin-top: 2px;
  font-size: 12px;
  color: rgba(var(--v-theme-on-surface), 0.7);
}

.pj-row__meta-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.pj-row__meta-item--muted {
  color: rgba(var(--v-theme-on-surface), 0.5);
}

.pj-row__progress {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 160px;
}

.pj-row__progress .v-progress-linear {
  flex: 1 1 auto;
}

.pj-row__status {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 4px;
  flex: 0 0 140px;
}

.pj-row__chip {
  min-width: 112px;
  justify-content: flex-start;
  font-weight: 700;
  letter-spacing: 0.02em;
}

/* Collapse the fixed progress/right rail on small screens */
@media (max-width: 760px) {
  .pj-row__progress {
    flex-basis: 90px;
  }
}

.pj-job-skeleton {
  min-height: 64px;
}

/* ─── Jobs pagination footer ─────────────────────────────────── */
.pj-pager {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 16px;
  padding: 8px 12px;
}

.pj-pager__size {
  max-width: 96px;
}

@keyframes shimmer {
  0% {
    background-position: -200% 0;
  }
  100% {
    background-position: 200% 0;
  }
}

:deep(.v-data-table__wrapper) {
  border-radius: 8px;
}

:deep(.v-data-table-header) {
  background-color: rgba(var(--v-theme-primary), 0.05);
}

:deep(.v-data-table-header th) {
  font-weight: 600 !important;
  color: rgb(var(--v-theme-primary)) !important;
}

:deep(.v-data-table__tbody tr:hover) {
  background-color: rgba(var(--v-theme-primary), 0.02) !important;
}

:deep(.v-card-title) {
  border-bottom: 1px solid rgba(var(--v-theme-primary), 0.1);
}

:deep(.v-skeleton-loader__bone) {
  animation: loading 1.5s infinite;
}

@keyframes loading {
  0% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
  100% {
    opacity: 1;
  }
}
</style>

