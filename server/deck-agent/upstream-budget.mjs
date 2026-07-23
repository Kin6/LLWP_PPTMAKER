export const MAX_UPSTREAM_CALLS_PER_MODEL_TURN = 3;

export function upstreamCallBudget(maxTurns) {
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) {
    throw new TypeError("Model turn budget must be a positive integer");
  }
  const budget = maxTurns * MAX_UPSTREAM_CALLS_PER_MODEL_TURN;
  if (!Number.isSafeInteger(budget)) throw new TypeError("Upstream-call budget exceeds the safe integer limit");
  return budget;
}
