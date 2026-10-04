import { describe, expect, it } from "vitest";
import { parseCapCents, parsePeriod, windowFor } from "../src/period";

describe("month window", () => {
  it("rolls at UTC month boundaries, including the new year", () => {
    expect(windowFor(Date.parse("2026-09-30T23:59:59.999Z"), "month")).toEqual({
      periodKey: "2026-09",
      resetsAt: "2026-10-01T00:00:00.000Z",
    });
    expect(windowFor(Date.parse("2026-10-01T00:00:00.000Z"), "month")).toEqual({
      periodKey: "2026-10",
      resetsAt: "2026-11-01T00:00:00.000Z",
    });
    expect(windowFor(Date.parse("2026-10-01T00:30:00.000Z"), "month").periodKey).toBe("2026-10");
    expect(windowFor(Date.parse("2026-12-31T23:59:59.999Z"), "month")).toEqual({
      periodKey: "2026-12",
      resetsAt: "2027-01-01T00:00:00.000Z",
    });
    expect(windowFor(Date.parse("2027-01-01T00:00:00.000Z"), "month").periodKey).toBe("2027-01");
  });

  it("keeps a lifetime bucket with no reset", () => {
    expect(parsePeriod("lifetime")).toBe("lifetime");
    expect(parsePeriod("none")).toBe("lifetime");
    expect(windowFor(Date.parse("2026-10-04T12:00:00.000Z"), "lifetime")).toEqual({
      periodKey: "lifetime",
      resetsAt: null,
    });
  });

  it("rejects a period or cap that is not a configured latch", () => {
    expect(parsePeriod(undefined)).toBe("month");
    expect(() => parsePeriod("weekly")).toThrow(/PERIOD/);
    expect(parseCapCents("1000")).toBe(1000);
    expect(parseCapCents(10)).toBe(10);
    expect(() => parseCapCents("0")).toThrow(/CAP_CENTS/);
    expect(() => parseCapCents("-5")).toThrow(/CAP_CENTS/);
    expect(() => parseCapCents("10.5")).toThrow(/CAP_CENTS/);
    expect(() => parseCapCents("")).toThrow(/CAP_CENTS/);
  });
});
