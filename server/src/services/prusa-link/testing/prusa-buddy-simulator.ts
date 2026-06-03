import type { PL_PrinterStateDto } from "@/services/prusa-link/dto/printer-state.dto";
import type { PL_JobStateDto } from "@/services/prusa-link/dto/job-state.dto";
import type { PL_StatusDto } from "@/services/prusa-link/dto/status.dto";

/**
 * Faithful simulator of the Prusa Buddy firmware print-state machine
 * (XL / MK4 / MINI / Core One), modelled directly on
 * `Prusa-Firmware-Buddy/src/state/printer_state.cpp`
 * (`get_print_state()` / `get_state()` / `to_str()`).
 *
 * Why this exists: PrusaLink has no websocket and the live `printer.state` it
 * reports on `/api/v1/status` is the *only* signal our job tracking has. The
 * mapping from the firmware's internal `State` enum + FSM overlays to the API
 * state string is non-obvious (e.g. BUSY can appear mid-print during crash
 * recovery; a finish may report READY instead of FINISHED). This simulator
 * reproduces that mapping exactly so we can drive our `PrinterEventsCache` /
 * `PrintJobService` through realistic, firmware-correct state sequences in
 * tests instead of guessing payloads or needing physical hardware.
 *
 * The simulator emits the three reads the polling adapter performs each tick
 * (`/api/printer`, `/api/v1/job`, `/api/v1/status`) so it composes with the
 * real `normalizePrusaLinkPoll()` — tests exercise the production code path.
 */

// Mirror of Buddy firmware's DeviceState enum (printer_state.hpp) and to_str().
export type DeviceState =
  | "UNKNOWN"
  | "IDLE"
  | "PRINTING"
  | "PAUSED"
  | "FINISHED"
  | "STOPPED"
  | "READY"
  | "BUSY"
  | "ATTENTION"
  | "ERROR";

// Mirror of the marlin_server `State` enum values referenced by
// `get_print_state()`. Only the values that affect the API state are modelled;
// names match the firmware verbatim for traceability.
export type PrintState =
  // Idle / Ready group
  | "Idle"
  | "WaitGui"
  | "PrintPreviewInit"
  | "PrintPreviewImage"
  | "PrintInit"
  | "Exit"
  // Printing group (incl. the finishing/aborting sub-states that stay PRINTING)
  | "Printing"
  | "Aborting_Begin"
  | "Aborting_WaitIdle"
  | "Aborting_UnloadFilament"
  | "Aborting_ParkHead"
  | "Aborting_Preview"
  | "Finishing_WaitIdle"
  | "Finishing_UnloadFilament"
  | "Finishing_ParkHead"
  | "PrintPreviewConfirmed"
  | "SerialPrintInit"
  // Busy group (power-panic / crash-recovery internals — mid-print!)
  | "PowerPanic_acFault"
  | "PowerPanic_Resume"
  | "CrashRecovery_Begin"
  | "CrashRecovery_Retracting"
  | "CrashRecovery_Lifting"
  | "CrashRecovery_ToolchangePowerPanic"
  | "CrashRecovery_XY_Measure"
  | "CrashRecovery_XY_HOME"
  // Attention group (within get_print_state)
  | "PrintPreviewQuestions"
  | "PowerPanic_AwaitingResume"
  | "CrashRecovery_Axis_NOK"
  | "CrashRecovery_Repeated_Crash"
  | "CrashRecovery_HOMEFAIL"
  | "CrashRecovery_Tool_Pickup"
  | "PrintPreviewToolsMapping"
  // Paused group
  | "Pausing_Begin"
  | "Pausing_WaitIdle"
  | "Pausing_ParkHead"
  | "Paused"
  | "Resuming_Begin"
  | "Resuming_Reheating"
  | "Resuming_UnparkHead_XY"
  | "Resuming_UnparkHead_ZE"
  | "Resuming_BufferData"
  | "MediaErrorRecovery_BufferData"
  | "Pausing_Failed_Code"
  // Terminal
  | "Finished"
  | "Aborted";

const IDLE_STATES = new Set<PrintState>([
  "Idle",
  "WaitGui",
  "PrintPreviewInit",
  "PrintPreviewImage",
  "PrintInit",
  "Exit",
]);

const PRINTING_STATES = new Set<PrintState>([
  "Printing",
  "Aborting_Begin",
  "Aborting_WaitIdle",
  "Aborting_UnloadFilament",
  "Aborting_ParkHead",
  "Aborting_Preview",
  "Finishing_WaitIdle",
  "Finishing_UnloadFilament",
  "Finishing_ParkHead",
  "PrintPreviewConfirmed",
  "SerialPrintInit",
]);

const BUSY_STATES = new Set<PrintState>([
  "PowerPanic_acFault",
  "PowerPanic_Resume",
  "CrashRecovery_Begin",
  "CrashRecovery_Retracting",
  "CrashRecovery_Lifting",
  "CrashRecovery_ToolchangePowerPanic",
  "CrashRecovery_XY_Measure",
  "CrashRecovery_XY_HOME",
]);

const ATTENTION_STATES = new Set<PrintState>([
  "PrintPreviewQuestions",
  "PowerPanic_AwaitingResume",
  "CrashRecovery_Axis_NOK",
  "CrashRecovery_Repeated_Crash",
  "CrashRecovery_HOMEFAIL",
  "CrashRecovery_Tool_Pickup",
  "PrintPreviewToolsMapping",
]);

const PAUSED_STATES = new Set<PrintState>([
  "Pausing_Begin",
  "Pausing_WaitIdle",
  "Pausing_ParkHead",
  "Paused",
  "Resuming_Begin",
  "Resuming_Reheating",
  "Resuming_UnparkHead_XY",
  "Resuming_UnparkHead_ZE",
  "Resuming_BufferData",
  "MediaErrorRecovery_BufferData",
  "Pausing_Failed_Code",
]);

/**
 * Verbatim port of `printer_state::get_print_state(State state, bool ready)`.
 */
export function getPrintState(state: PrintState, ready: boolean): DeviceState {
  if (ATTENTION_STATES.has(state)) return "ATTENTION";
  if (IDLE_STATES.has(state)) return ready ? "READY" : "IDLE";
  if (PRINTING_STATES.has(state)) return "PRINTING";
  if (BUSY_STATES.has(state)) return "BUSY";
  if (PAUSED_STATES.has(state)) return "PAUSED";
  if (state === "Finished") return ready ? "READY" : "FINISHED";
  if (state === "Aborted") return ready ? "READY" : "STOPPED";
  return "UNKNOWN";
}

/**
 * The relevant top-FSM overlays from `get_state()` that override the raw
 * print-state mapping. Modelled as discrete inputs because tests drive them via
 * scenario helpers rather than the firmware's phase indices.
 */
export type FsmOverlay =
  // Load/Unload while a print is active: ATTENTION (filament runout / MMU
  // error / stuck filament) or normal progress (still PRINTING).
  | { kind: "loadUnloadWhilePrinting"; attention: boolean }
  // Load/Unload from a menu (not printing) → BUSY.
  | { kind: "loadUnloadStandalone" }
  // Crash recovery: ATTENTION if it needs the user, else the underlying
  // CrashRecovery_* state already maps to BUSY via get_print_state.
  | { kind: "crashRecovery"; attention: boolean }
  // Quick pause from the screen → PAUSED.
  | { kind: "quickPause" }
  // Selftest / calibration / preheat / wait → busy_state (PRINTING if a print
  // is active underneath, else BUSY).
  | { kind: "busyFsm" }
  // A warning dialog. ATTENTION if it's a "hard" warning or fired while
  // active; otherwise the underlying print state shows through.
  | { kind: "warning"; attention: boolean };

export interface SimulatorOptions {
  /**
   * "buddy" (default): live state lives on `/api/v1/status` `printer.state`;
   * `/api/printer` carries NO `link_state` (matches XL/MK4 firmware).
   * "einsy": live state lives on `/api/printer` `state.flags.link_state`;
   * `/api/v1/status` may be absent (set via `statusAvailable: false`).
   */
  mode?: "buddy" | "einsy";
  /** Einsy shim sometimes has no /api/v1/status; null it to test the fallback. */
  statusAvailable?: boolean;
  /** Printer-ready flag — collapses Idle/Finished/Aborted to READY when true. */
  ready?: boolean;
}

export interface SimJob {
  id: number;
  /** Friendly long name (PrusaLink `file.display`). */
  display: string;
  /** FAT 8.3 / short name (`file.name`). */
  name: string;
  /** Storage-relative path with leading storage segment (`file.path`). */
  path: string;
}

/**
 * Drives a Buddy printer through firmware-faithful state sequences. Scenario
 * helpers (`startPrint`, `pause`, `filamentRunout`, `crashRecoveryAuto`, …) set
 * the underlying `State` + overlay; `deviceState()` computes the API string
 * exactly as the firmware would, and the `get*Response()` methods serialize the
 * three poll reads.
 */
export class PrusaBuddySimulator {
  private state: PrintState = "Idle";
  private overlay: FsmOverlay | null = null;
  private ready: boolean;
  private readonly mode: "buddy" | "einsy";
  private statusAvailable: boolean;

  private job: SimJob | null = null;
  private completion = 0; // 0..1
  private timePrinting = 0;
  private timeRemaining = 0;
  private attentionMessage: string | null = null;
  /** Override used only for fatal faults the print-state machine can't express. */
  private forcedDeviceState: DeviceState | null = null;
  private jobIdSeq = 1;

  constructor(opts: SimulatorOptions = {}) {
    this.mode = opts.mode ?? "buddy";
    this.statusAvailable = opts.statusAvailable ?? true;
    this.ready = opts.ready ?? false;
  }

  // ---- firmware state computation (port of get_state) --------------------

  deviceState(): DeviceState {
    if (this.forcedDeviceState) return this.forcedDeviceState;

    const isPrinting = PRINTING_STATES.has(this.state);
    const busyState: DeviceState = isPrinting ? "PRINTING" : "BUSY";

    if (this.overlay) {
      switch (this.overlay.kind) {
        case "loadUnloadWhilePrinting":
          return this.overlay.attention ? "ATTENTION" : "PRINTING";
        case "loadUnloadStandalone":
          return "BUSY";
        case "crashRecovery":
          if (this.overlay.attention) return "ATTENTION";
          break; // else falls through to get_print_state (CrashRecovery_* → BUSY)
        case "quickPause":
          return "PAUSED";
        case "busyFsm":
          return busyState;
        case "warning": {
          const result = getPrintState(this.state, this.ready);
          const active = result === "BUSY" || result === "PAUSED" || result === "PRINTING";
          return this.overlay.attention || active ? "ATTENTION" : result;
        }
      }
    }
    return getPrintState(this.state, this.ready);
  }

  // ---- high-level scenario API -------------------------------------------

  setReady(ready: boolean): this {
    this.ready = ready;
    return this;
  }

  /** Printer sitting idle with no job loaded. */
  idle(): this {
    this.state = "Idle";
    this.overlay = null;
    this.job = null;
    this.completion = 0;
    this.attentionMessage = null;
    this.forcedDeviceState = null;
    return this;
  }

  /** Begin a print of a file. */
  startPrint(file: { display: string; name?: string; path?: string } = { display: "part.bgcode" }): this {
    const display = file.display;
    this.job = {
      id: this.jobIdSeq++,
      display,
      name: file.name ?? toShortName(display),
      path: file.path ?? `/usb/${display}`,
    };
    this.state = "Printing";
    this.overlay = null;
    this.completion = 0;
    this.timePrinting = 0;
    this.attentionMessage = null;
    this.forcedDeviceState = null;
    return this;
  }

  /** Advance print progress (0..100). */
  progress(percent: number): this {
    this.completion = Math.min(1, Math.max(0, percent / 100));
    this.timePrinting += 1;
    return this;
  }

  pause(): this {
    this.state = "Paused";
    this.overlay = null;
    return this;
  }

  resume(): this {
    this.state = "Printing";
    this.overlay = null;
    return this;
  }

  /**
   * Finish the print. Firmware: Finishing_* (still PRINTING) → Finished, which
   * maps to FINISHED, or READY when the printer-ready flag is set. Pass
   * `{ clearJob: true }` to model the XL clearing `job` on the terminal tick.
   */
  finish(opts: { clearJob?: boolean } = {}): this {
    this.state = "Finished";
    this.overlay = null;
    this.completion = 1;
    if (opts.clearJob) this.job = null;
    return this;
  }

  /** User aborted the print. Firmware: Aborting_* (PRINTING) → Aborted → STOPPED (or READY if ready). */
  cancel(opts: { clearJob?: boolean } = {}): this {
    this.state = "Aborted";
    this.overlay = null;
    if (opts.clearJob) this.job = null;
    return this;
  }

  /** Filament runout mid-print → ATTENTION (job still loaded). */
  filamentRunout(message = "Filament runout"): this {
    this.overlay = { kind: "loadUnloadWhilePrinting", attention: true };
    this.attentionMessage = message;
    return this;
  }

  /** User reloads filament and resumes — back to PRINTING. */
  resolveAttentionAndResume(): this {
    this.overlay = null;
    this.state = "Printing";
    this.attentionMessage = null;
    return this;
  }

  /** Automatic crash recovery (no user input) — reports BUSY mid-print. */
  crashRecoveryAuto(): this {
    this.state = "CrashRecovery_Begin";
    this.overlay = { kind: "crashRecovery", attention: false };
    return this;
  }

  /** Crash recovery that needs the user — ATTENTION. */
  crashRecoveryAttention(): this {
    this.state = "CrashRecovery_Axis_NOK";
    this.overlay = { kind: "crashRecovery", attention: true };
    this.attentionMessage = "Crash detected";
    return this;
  }

  /** Power panic mid-print — BUSY during the ac-fault/resume phases. */
  powerPanicBusy(): this {
    this.state = "PowerPanic_acFault";
    this.overlay = null;
    return this;
  }

  /** Power panic awaiting the user to resume — ATTENTION. */
  powerPanicAwaitingResume(): this {
    this.state = "PowerPanic_AwaitingResume";
    this.overlay = null;
    this.attentionMessage = "Power panic — resume?";
    return this;
  }

  /** The printer settles to idle after a terminal/attention tick (print removed). */
  becomeIdleOrReady(opts: { clearJob?: boolean } = { clearJob: true }): this {
    this.state = "Idle";
    this.overlay = null;
    if (opts.clearJob ?? true) this.job = null;
    this.attentionMessage = null;
    this.forcedDeviceState = null;
    return this;
  }

  /**
   * Force a hard ERROR device-state. The print-state machine in
   * get_print_state never yields Error; it surfaces via other firmware paths
   * (redscreen / fatal fault) reported on the API as state "ERROR".
   */
  fatalError(message = "Printer error"): this {
    this.forcedDeviceState = "ERROR";
    this.attentionMessage = message;
    return this;
  }

  /** Simulate the /api/v1/status read failing this tick (adapter catches it → null). */
  setStatusAvailable(available: boolean): this {
    this.statusAvailable = available;
    return this;
  }

  /** Directly set the underlying firmware State (for low-level fidelity tests). */
  setState(state: PrintState): this {
    this.state = state;
    this.overlay = null;
    return this;
  }

  getJob(): SimJob | null {
    return this.job;
  }

  // ---- serialization to the three poll reads ------------------------------

  /** `GET /api/printer` (OctoPrint-compat). */
  getPrinterStateResponse(): PL_PrinterStateDto {
    const ds = this.deviceState();
    const flags: PL_PrinterStateDto["state"]["flags"] = {
      operational: ds !== "ERROR",
      paused: false,
      printing: false,
      cancelling: false,
      pausing: false,
      error: false,
      sdReady: true,
      closedOnError: false,
      ready: false,
      busy: false,
    };
    // Einsy carries the live state here; Buddy does not (adapter falls back to
    // /api/v1/status). `state.text` is left as a neutral label on Buddy — the
    // adapter overwrites it from link_state/status anyway.
    if (this.mode === "einsy") {
      flags.link_state = ds;
    }
    return {
      temperature: {
        tool0: { actual: 215, target: 215, display: 215, offset: 0 },
        bed: { actual: 60, target: 60, offset: 0 },
      },
      state: {
        // Einsy carries the live link_state in both `text` and `flags`. Buddy's
        // OctoPrint-compat /api/printer reports "Printing" during a print (the
        // adapter does NOT overwrite text while PRINTING — it trusts this) and
        // a neutral "Operational" otherwise (the adapter overwrites that from
        // the /api/v1/status link_state for every non-PRINTING state).
        text: this.mode === "einsy" ? ds : ds === "PRINTING" ? "Printing" : "Operational",
        flags,
      },
      telemetry: {
        "temp-bed": 60,
        "temp-nozzle": 215,
        "print-speed": 100,
        "z-height": 5,
        material: "PLA",
      },
    };
  }

  /** `GET /api/v1/job`. */
  getJobStateResponse(): PL_JobStateDto {
    if (!this.job) {
      return {
        state: this.deviceState(),
        progress: { completion: 0, printTime: 0, printTimeLeft: 0 },
      };
    }
    return {
      state: this.deviceState(),
      job: {
        estimatedPrintTime: this.timeRemaining + this.timePrinting,
        file: {
          name: this.job.name,
          path: this.job.path,
          display: this.job.display,
        },
      },
      progress: {
        completion: this.completion,
        printTime: this.timePrinting,
        printTimeLeft: this.timeRemaining,
      },
    };
  }

  /** `GET /api/v1/status` — null when this read is unavailable (Einsy / blip). */
  getStatusResponse(): PL_StatusDto | null {
    if (!this.statusAvailable) return null;
    const ds = this.deviceState();
    return {
      printer: {
        state: ds,
        temp_nozzle: 215,
        target_nozzle: 215,
        temp_bed: 60,
        target_bed: 60,
        axis_x: 0,
        axis_y: 0,
        axis_z: 5,
        flow: 100,
        speed: 100,
        fan_hotend: 8000,
        fan_print: 5000,
        status_printer: { ok: ds !== "ERROR" && ds !== "ATTENTION", message: this.attentionMessage ?? "" },
        status_connect: { ok: true, message: "" },
      },
      storage: { name: "usb", path: "/usb/", read_only: false, free_space: 1_000_000_000 },
      job: this.job
        ? {
            id: this.job.id,
            progress: Math.round(this.completion * 100),
            time_remaining: this.timeRemaining,
            time_printing: this.timePrinting,
          }
        : undefined,
    };
  }
}

/** Crude FAT 8.3-ish short name, mirroring how PrusaLink truncates display names. */
function toShortName(display: string): string {
  const dot = display.lastIndexOf(".");
  const base = (dot >= 0 ? display.slice(0, dot) : display).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const ext = dot >= 0 ? display.slice(dot).toUpperCase() : "";
  const stem = base.length > 6 ? `${base.slice(0, 6)}~1` : base || "FILE";
  return `${stem}${ext}`;
}
