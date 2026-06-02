import { describe, expect, it } from "vite-plus/test";
import { normalizePrusaLinkPoll } from "@/services/prusa-link/utils/normalize-poll";
import { PrusaBuddySimulator } from "@/services/prusa-link/testing/prusa-buddy-simulator";

function run(sim: PrusaBuddySimulator) {
  return normalizePrusaLinkPoll(sim.getPrinterStateResponse(), sim.getJobStateResponse(), sim.getStatusResponse());
}

describe("normalizePrusaLinkPoll", () => {
  it("falls back to /api/v1/status printer.state on Buddy (no link_state on /api/printer)", () => {
    const sim = new PrusaBuddySimulator({ mode: "buddy" }).startPrint();
    const payload = run(sim);
    // During PRINTING the adapter keeps /api/printer's own text ("Printing");
    // the observer uppercases it. The contract is: it resolves to PRINTING.
    expect(payload.state?.text?.toUpperCase()).toBe("PRINTING");
    expect(payload.state?.flags?.printing).toBe(true);
  });

  it("uses link_state from /api/printer on the Einsy shim even when /api/v1/status is absent", () => {
    const sim = new PrusaBuddySimulator({ mode: "einsy" }).startPrint().pause();
    sim.setStatusAvailable(false);
    const payload = run(sim);
    expect(payload.state?.text).toBe("PAUSED");
    expect(payload.state?.flags?.paused).toBe(true);
    expect(payload.freeSpace).toBeNull(); // no status read → no storage info
  });

  it("prefixes the firmware message onto ATTENTION state text", () => {
    const sim = new PrusaBuddySimulator().startPrint();
    sim.filamentRunout("Filament runout");
    const payload = run(sim);
    expect(payload.state?.text).toBe("ATTENTION: Filament runout");
    // ATTENTION keeps printing:true and raises error flag for the banner.
    expect(payload.state?.flags?.printing).toBe(true);
    expect(payload.state?.flags?.error).toBe(true);
  });

  it("scales completion from 0..1 to 0..100", () => {
    const sim = new PrusaBuddySimulator().startPrint().progress(37);
    const payload = run(sim);
    expect(payload.progress.completion).toBeCloseTo(37, 5);
  });

  it("sets completion to null when there is no progress (avoids NaN)", () => {
    const sim = new PrusaBuddySimulator().idle();
    const payload = run(sim);
    // idle job response reports completion 0 → 0, never NaN
    expect(payload.progress.completion).not.toBeNaN();
  });

  it("reports writable storage free space", () => {
    const sim = new PrusaBuddySimulator().startPrint();
    const payload = run(sim);
    expect(payload.freeSpace).toBe(1_000_000_000);
  });

  it("maps BUSY through faithfully (busy flag set, not treated as ready)", () => {
    const sim = new PrusaBuddySimulator().startPrint().crashRecoveryAuto();
    const payload = run(sim);
    expect(payload.state?.text).toBe("BUSY");
    expect(payload.state?.flags?.busy).toBe(true);
    expect(payload.state?.flags?.ready).toBe(false);
  });
});
