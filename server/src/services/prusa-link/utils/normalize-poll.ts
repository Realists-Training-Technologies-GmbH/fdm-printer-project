import type { PL_PrinterStateDto } from "@/services/prusa-link/dto/printer-state.dto";
import type { PL_JobStateDto } from "@/services/prusa-link/dto/job-state.dto";
import type { PL_StatusDto } from "@/services/prusa-link/dto/status.dto";

/**
 * The `current` event payload the polling adapter emits and that
 * `PrinterEventsCache.onPrusaLinkPollMessage` consumes. Kept loose (`any`-ish)
 * because it is a merge of the OctoPrint-compat `/api/printer` shape plus
 * fields pulled from `/api/v1/status` and `/api/v1/job`.
 */
export interface PrusaLinkCurrentPayload {
  state?: { text?: string; flags?: Record<string, unknown> };
  temps?: unknown;
  job?: unknown;
  progress: {
    printTime: number | null;
    printTimeLeft: number | null;
    completion: number | null;
  };
  telemetry: unknown;
  transfer: { id: number; progress: number; bytes: number; timeTransferring: number } | null;
  freeSpace: number | null;
  printerMessage: string | null;
  [key: string]: unknown;
}

/**
 * Pure normalization of a single PrusaLink poll into the `current` event
 * payload. Extracted verbatim from `PrusaLinkHttpPollingAdapter.pollOnce` so it
 * can be unit-tested and driven by the firmware simulator without doing real
 * HTTP/digest round-trips.
 *
 * Inputs are the three reads the adapter performs each tick:
 *  - `printerState` — `GET /api/printer` (OctoPrint-compat). On the Einsy shim
 *    this carries the live `state.flags.link_state`; on Buddy it does not.
 *  - `jobState`    — `GET /api/v1/job` (file + progress).
 *  - `status`      — `GET /api/v1/status` (Buddy's live `printer.state`, temps,
 *    transfer, storage). May be null when that read failed.
 *
 * NOTE: this mutates `printerState.state.text`/`.flags` in place, exactly as the
 * original adapter did. That is safe because `printerState` is a fresh response
 * object per poll.
 */
/**
 * Coerce a PrusaLink `transfer.progress` into a 0–1 fraction.
 *
 * The Einsy MK3 reports a 0–100 percentage (verified on hardware); Buddy may
 * report either, so treat anything >1 as a percentage and divide it back, while
 * leaving an already-fractional value alone. Result is clamped to [0, 1].
 */
export function normalizeProgressFraction(progress: number): number {
  if (!Number.isFinite(progress) || progress <= 0) return 0;
  const fraction = progress > 1 ? progress / 100 : progress;
  return Math.min(1, fraction);
}

export function normalizePrusaLinkPoll(
  printerState: PL_PrinterStateDto,
  jobState: PL_JobStateDto,
  status: PL_StatusDto | null,
): PrusaLinkCurrentPayload {
  // Native/Buddy PrusaLink (XL, MK4, …) does NOT emit `link_state` on
  // /api/printer — it carries the live state on /api/v1/status instead.
  // The legacy Einsy shim (MK3/MK2.5) emits `link_state`. Fall back to the
  // v1 status state so the flag mapping below works on every firmware.
  const linkState = printerState.state?.flags?.link_state ?? status?.printer?.state;
  const attentionMessage = status?.printer?.status_printer?.message;
  if (linkState && linkState !== "PRINTING") {
    // When the printer is in ATTENTION, surface the firmware's reason
    // ("Filament runout", "Heating error", etc.) instead of the bare state.
    if (linkState.toUpperCase() === "ATTENTION" && attentionMessage) {
      printerState.state.text = `ATTENTION: ${attentionMessage}`;
    } else {
      printerState.state.text = linkState;
    }
  }

  // Map PrusaLink's link_state to the boolean flag set the dashboard reads.
  const flags = printerState.state?.flags;
  if (flags) {
    const ls = (linkState ?? "").toUpperCase();
    flags.operational = ls !== "ERROR";
    // ATTENTION still has a job loaded and "running" from the firmware's
    // perspective — keep `printing: true` so the dashboard shows the
    // pause/cancel controls. The `error: true` flag tells the UI to surface
    // the attention banner.
    flags.printing = ls === "PRINTING" || ls === "ATTENTION";
    flags.paused = ls === "PAUSED";
    flags.pausing = ls === "PAUSING";
    flags.cancelling = ls === "STOPPED" || ls === "CANCELLING";
    flags.error = ls === "ERROR" || ls === "ATTENTION";
    flags.closedOnError = ls === "ERROR";
    flags.ready = ls === "READY" || ls === "IDLE" || ls === "OPERATIONAL" || ls === "FINISHED";
    flags.busy = ls === "BUSY";
  }

  // Avoid `undefined * 100 = NaN` propagating to the dashboard.
  const rawCompletion = jobState.progress?.completion;
  const completion = typeof rawCompletion === "number" ? rawCompletion * 100 : null;

  const richTelemetry = status?.printer
    ? {
        zHeight: (status.printer as any).axis_z ?? null,
        fanHotend: status.printer.fan_hotend ?? null,
        fanPrint: status.printer.fan_print ?? null,
        speed: status.printer.speed ?? null,
        flow: status.printer.flow ?? null,
      }
    : null;
  const transfer = status?.transfer
    ? {
        id: status.transfer.id,
        // Normalise to a 0–1 fraction (the app's internal contract). PrusaLink
        // firmwares report `transfer.progress` on different scales: the legacy
        // Einsy MK3 sends a 0–100 percentage (verified on hardware: 3.97, 13.02,
        // …), so passing it through verbatim made the UI — which expects 0–1 —
        // reject every value > 1 and show no number. Divide a percentage back to
        // a fraction; leave an already-fractional value (≤1) untouched. Clamped
        // so a stray reading can't push the bar past 100%.
        progress: normalizeProgressFraction(status.transfer.progress),
        bytes: status.transfer.data_transferred,
        timeTransferring: status.transfer.time_transferring,
      }
    : null;
  // `storage` is a single object on Buddy firmware but an array on the
  // Einsy shim (MK3/MK2.5). Report the writable storage's free space.
  const storageList = Array.isArray(status?.storage) ? status.storage : status?.storage ? [status.storage] : [];
  const freeSpace = (storageList.find((s) => !s.read_only) ?? storageList[0])?.free_space ?? null;
  const printerMessage = status?.printer?.status_printer?.message ?? null;

  // The rest of the system expects an OctoPrint-style `temps` array. PrusaLink
  // only sends a single-snapshot `temperature` object; mirror it into a
  // one-element array so consumers stay adapter-agnostic.
  const temperature = (printerState as any)?.temperature;
  const tempsArray =
    temperature?.tool0 || temperature?.bed
      ? [
          {
            time: Math.floor(Date.now() / 1000),
            tool0: temperature?.tool0,
            bed: temperature?.bed,
          },
        ]
      : (printerState as any)?.temps;

  return {
    ...printerState,
    temps: tempsArray,
    job: jobState.job,
    progress: {
      printTime: jobState.progress?.printTime ?? null,
      printTimeLeft: jobState.progress?.printTimeLeft ?? null,
      completion,
    },
    telemetry: richTelemetry ?? (printerState as any).telemetry ?? null,
    transfer,
    freeSpace,
    printerMessage,
  };
}
