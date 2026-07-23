const CANONICAL_JOB_ID = /^job-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type LocationSource = Pick<Location, "href"> | URL | string;

function currentLocation(): LocationSource | null {
  return typeof window === "undefined" ? null : window.location;
}

function toUrl(source: LocationSource): URL {
  if (typeof source === "string") {
    return new URL(source, typeof window === "undefined" ? "http://localhost" : window.location.origin);
  }
  if (source instanceof URL) return new URL(source.href);
  return new URL(source.href);
}

export function isDeckJobId(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_JOB_ID.test(value);
}

export function readDeckJobId(source: LocationSource | null = currentLocation()): string | null {
  if (!source) return null;
  const values = toUrl(source).searchParams.getAll("job");
  return values.length === 1 && isDeckJobId(values[0]) ? values[0] : null;
}

export function replaceDeckJobId(
  jobId: string | null,
  source: LocationSource | null = currentLocation(),
  historyObject: Pick<History, "replaceState" | "state"> | null = typeof window === "undefined"
    ? null
    : window.history,
): void {
  if (jobId !== null && !isDeckJobId(jobId)) throw new TypeError("Invalid deck job ID");
  if (!source || !historyObject) return;

  const url = toUrl(source);
  if (jobId === null) url.searchParams.delete("job");
  else url.searchParams.set("job", jobId);
  historyObject.replaceState(
    historyObject.state,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

export const readDeckJobLocation = readDeckJobId;
export const writeDeckJobLocation = replaceDeckJobId;
