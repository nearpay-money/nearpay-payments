import { describe, expect, it } from "vitest";
import { compareKillSwitchCopy, DIVERGENCE_FIX } from "../../src/domain/kill-switch-copy.js";

describe("compareKillSwitchCopy (periodic read, RAILS-1)", () => {
  const copy = (engaged: boolean, version: number, known = true) => ({ known, engaged, version });
  it("agrees on the same state and version", () => {
    expect(compareKillSwitchCopy(copy(false, 6), { engaged: false, version: 6 })).toBeNull();
    expect(compareKillSwitchCopy(copy(true, 5), { engaged: true, version: 5 })).toBeNull();
  });
  it("an unknown copy diverges", () => {
    expect(compareKillSwitchCopy(copy(true, 0, false), { engaged: true, version: 0 })).toBe("copy_unknown");
  });
  it("sentinel older than the copy: sentinel_behind (the copy never moves back)", () => {
    expect(compareKillSwitchCopy(copy(false, 7), { engaged: true, version: 3 })).toBe("sentinel_behind");
  });
  it("sentinel newer than the copy: copy_behind", () => {
    expect(compareKillSwitchCopy(copy(true, 5), { engaged: false, version: 6 })).toBe("copy_behind");
  });
  it("same version, different state: an operator override", () => {
    expect(compareKillSwitchCopy(copy(false, 5), { engaged: true, version: 5 })).toBe("value_overridden");
  });
  it("an unversioned answer (sentinel 0.2.0) compares the state only", () => {
    expect(compareKillSwitchCopy(copy(false, 9), { engaged: false, version: null })).toBeNull();
    expect(compareKillSwitchCopy(copy(false, 9), { engaged: true, version: null })).toBe("value_overridden");
  });
  it("every divergence has a fix", () => {
    for (const d of ["copy_unknown", "sentinel_behind", "copy_behind", "value_overridden"] as const)
      expect(DIVERGENCE_FIX[d].length).toBeGreaterThan(10);
  });
});
