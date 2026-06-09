import { describe, expect, it } from "vite-plus/test";
import { normalizeProgressFraction } from "@/services/prusa-link/utils/normalize-poll";

// PrusaLink firmwares report `transfer.progress` on different scales: the
// legacy Einsy MK3 sends a 0–100 percentage (verified on hardware), while the
// app's internal contract — and the UI — expect a 0–1 fraction. Without
// normalisation the MK3's values (>1) were rejected and no percentage showed.
describe("normalizeProgressFraction — MK3 (0–100) vs fractional (0–1)", () => {
  it("divides a 0–100 percentage back to a 0–1 fraction (MK3)", () => {
    expect(normalizeProgressFraction(13.02)).toBeCloseTo(0.1302, 5);
    expect(normalizeProgressFraction(3.97)).toBeCloseTo(0.0397, 5);
    expect(normalizeProgressFraction(100)).toBe(1);
  });

  it("leaves an already-fractional value untouched", () => {
    expect(normalizeProgressFraction(0.5)).toBe(0.5);
    expect(normalizeProgressFraction(1)).toBe(1);
  });

  it("clamps to [0, 1] and treats junk as 0", () => {
    expect(normalizeProgressFraction(150)).toBe(1); // never past 100%
    expect(normalizeProgressFraction(0)).toBe(0);
    expect(normalizeProgressFraction(-5)).toBe(0);
    expect(normalizeProgressFraction(NaN)).toBe(0);
  });
});
