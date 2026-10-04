export type PeriodMode = "month" | "lifetime";

export type PeriodWindow = {
  periodKey: string;
  resetsAt: string | null;
};

export function parsePeriod(value: unknown): PeriodMode {
  if (value === undefined || value === "month") {
    return "month";
  }
  if (value === "lifetime" || value === "none") {
    return "lifetime";
  }
  throw new Error("PERIOD must be month, lifetime, or none");
}

export function parseCapCents(value: unknown): number {
  const raw = typeof value === "number" ? String(value) : value;
  if (typeof raw !== "string" || !/^[1-9][0-9]*$/.test(raw)) {
    throw new Error("CAP_CENTS must be a positive integer");
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("CAP_CENTS must be a positive integer");
  }
  return parsed;
}

/** Calendar month in UTC, or a single lifetime bucket that never resets. */
export function windowFor(nowMs: number, period: PeriodMode): PeriodWindow {
  if (period === "lifetime") {
    return { periodKey: "lifetime", resetsAt: null };
  }
  const now = new Date(nowMs);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const periodKey = `${year}-${String(month + 1).padStart(2, "0")}`;
  const resetsAt = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)).toISOString();
  return { periodKey, resetsAt };
}
