import { describe, expect, it } from "vite-plus/test";
import {
  getPrintState,
  PrusaBuddySimulator,
  type PrintState,
} from "@/services/prusa-link/testing/prusa-buddy-simulator";

describe("getPrintState — verbatim port of Buddy firmware printer_state.cpp", () => {
  it("maps idle-group states to IDLE, or READY when the ready flag is set", () => {
    const idle: PrintState[] = ["Idle", "WaitGui", "PrintPreviewInit", "PrintPreviewImage", "PrintInit", "Exit"];
    for (const s of idle) {
      expect(getPrintState(s, false)).toBe("IDLE");
      expect(getPrintState(s, true)).toBe("READY");
    }
  });

  it("keeps all finishing/aborting sub-states as PRINTING", () => {
    const printing: PrintState[] = [
      "Printing",
      "Finishing_WaitIdle",
      "Finishing_UnloadFilament",
      "Finishing_ParkHead",
      "Aborting_Begin",
      "Aborting_WaitIdle",
      "Aborting_UnloadFilament",
      "Aborting_ParkHead",
      "Aborting_Preview",
      "PrintPreviewConfirmed",
      "SerialPrintInit",
    ];
    for (const s of printing) {
      expect(getPrintState(s, false)).toBe("PRINTING");
      // ready flag must not override an active print
      expect(getPrintState(s, true)).toBe("PRINTING");
    }
  });

  it("maps crash-recovery / power-panic internals to BUSY (mid-print!)", () => {
    const busy: PrintState[] = [
      "PowerPanic_acFault",
      "PowerPanic_Resume",
      "CrashRecovery_Begin",
      "CrashRecovery_Retracting",
      "CrashRecovery_Lifting",
      "CrashRecovery_ToolchangePowerPanic",
      "CrashRecovery_XY_Measure",
      "CrashRecovery_XY_HOME",
    ];
    for (const s of busy) expect(getPrintState(s, false)).toBe("BUSY");
  });

  it("maps the user-intervention crash/preview/power states to ATTENTION", () => {
    const attention: PrintState[] = [
      "PrintPreviewQuestions",
      "PowerPanic_AwaitingResume",
      "CrashRecovery_Axis_NOK",
      "CrashRecovery_Repeated_Crash",
      "CrashRecovery_HOMEFAIL",
      "CrashRecovery_Tool_Pickup",
      "PrintPreviewToolsMapping",
    ];
    for (const s of attention) {
      expect(getPrintState(s, false)).toBe("ATTENTION");
      expect(getPrintState(s, true)).toBe("ATTENTION");
    }
  });

  it("maps all pausing/resuming sub-states to PAUSED", () => {
    const paused: PrintState[] = [
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
    ];
    for (const s of paused) expect(getPrintState(s, false)).toBe("PAUSED");
  });

  it("collapses Finished/Aborted to READY when ready, else FINISHED/STOPPED", () => {
    expect(getPrintState("Finished", false)).toBe("FINISHED");
    expect(getPrintState("Finished", true)).toBe("READY");
    expect(getPrintState("Aborted", false)).toBe("STOPPED");
    expect(getPrintState("Aborted", true)).toBe("READY");
  });
});

describe("PrusaBuddySimulator — scenario state computation", () => {
  it("idle → printing → finished produces IDLE/PRINTING/FINISHED", () => {
    const sim = new PrusaBuddySimulator();
    expect(sim.idle().deviceState()).toBe("IDLE");
    expect(sim.startPrint({ display: "WIRBEL_TESTPART.BGC" }).deviceState()).toBe("PRINTING");
    expect(sim.finish().deviceState()).toBe("FINISHED");
  });

  it("a finished print reports READY when the printer-ready flag is set (XL behaviour)", () => {
    const sim = new PrusaBuddySimulator({ ready: true });
    sim.startPrint();
    expect(sim.deviceState()).toBe("PRINTING");
    expect(sim.finish().deviceState()).toBe("READY");
  });

  it("filament runout reports ATTENTION but keeps the job loaded", () => {
    const sim = new PrusaBuddySimulator();
    sim.startPrint({ display: "part.bgcode" });
    sim.filamentRunout();
    expect(sim.deviceState()).toBe("ATTENTION");
    expect(sim.getJob()).not.toBeNull();
    expect(sim.resolveAttentionAndResume().deviceState()).toBe("PRINTING");
  });

  it("automatic crash recovery reports BUSY mid-print, then back to PRINTING", () => {
    const sim = new PrusaBuddySimulator();
    sim.startPrint();
    expect(sim.crashRecoveryAuto().deviceState()).toBe("BUSY");
    expect(sim.resolveAttentionAndResume().deviceState()).toBe("PRINTING");
  });

  it("a crash needing the user reports ATTENTION", () => {
    const sim = new PrusaBuddySimulator();
    sim.startPrint();
    expect(sim.crashRecoveryAttention().deviceState()).toBe("ATTENTION");
  });

  it("serializes the three poll reads with the live state on /api/v1/status for Buddy", () => {
    const sim = new PrusaBuddySimulator({ mode: "buddy" });
    sim.startPrint({ display: "part.bgcode" }).progress(42);

    const printer = sim.getPrinterStateResponse();
    const status = sim.getStatusResponse();
    const job = sim.getJobStateResponse();

    // Buddy does NOT put link_state on /api/printer.
    expect(printer.state.flags.link_state).toBeUndefined();
    // Live state lives on /api/v1/status.
    expect(status?.printer.state).toBe("PRINTING");
    expect(job.job?.file.display).toBe("part.bgcode");
    expect(job.progress.completion).toBeCloseTo(0.42, 5);
  });

  it("serializes link_state on /api/printer for the Einsy shim", () => {
    const sim = new PrusaBuddySimulator({ mode: "einsy" });
    sim.startPrint().pause();
    const printer = sim.getPrinterStateResponse();
    expect(printer.state.flags.link_state).toBe("PAUSED");
  });
});
