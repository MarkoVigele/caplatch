export type GateDecision = "ok" | "unconfigured" | "unauthorized";

/**
 * Bearer check for GATE_TOKEN. An unset or blank secret stays closed.
 * A missing, empty, or wrong bearer is unauthorized. The compare does not
 * stop at the first differing byte.
 */
export function readGate(authorization: string | null, secret: string | undefined): GateDecision {
  if (typeof secret !== "string" || secret.trim().length === 0) {
    return "unconfigured";
  }
  const presented = bearerValue(authorization);
  if (presented === null) {
    return "unauthorized";
  }
  if (!sameSecret(presented, secret.trim())) {
    return "unauthorized";
  }
  return "ok";
}

function bearerValue(authorization: string | null): string | null {
  if (authorization === null) {
    return null;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  const token = match?.[1];
  if (!token) {
    return null;
  }
  return token;
}

function sameSecret(presented: string, expected: string): boolean {
  const left = new TextEncoder().encode(presented);
  const right = new TextEncoder().encode(expected);
  let mismatch = left.length === right.length ? 0 : 1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return mismatch === 0;
}
