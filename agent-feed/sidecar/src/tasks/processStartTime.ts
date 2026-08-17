// When a process started, from the two ctime-formatted clocks this feature reads.
//
// Its own module because there are two consumers with nothing else in common: the session registry
// checks a pid's start against the harness's record to defeat pid reuse, and the task probe asks a
// live shell how long it has been running. One parser, one set of scars.
//
// Both clocks are ctime-shaped and only one of them is local time. Getting that wrong fails
// silently, in the direction where the panel reports no background work at all.

const MONTHS: Readonly<Record<string, number>> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

interface CTimeParts {
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  year: number;
}

/**
 * Split a ctime-style stamp: `Fri Aug 14 17:10:48 2026`.
 *
 * Whitespace-tolerant because `ps` pads single-digit days to a fixed width, so a first-of-month
 * process reads `Mon Aug  3 16:42:02 2026` with two spaces.
 *
 * The month is found by NAME rather than by position, because position is not stable: `ps` formats
 * `lstart` per locale, and under `en_CA` it emits `Fri 14 Aug 13:10:48 2026` with the day first.
 * The probe now forces `LC_ALL=C` so this should always see the American order, but a parser that
 * cannot be broken by word order is three lines, and the failure it prevents is silent -- every
 * session read as a pid mismatch, and a panel that reports no background work at all.
 */
function parseCTime(text: string): CTimeParts | null {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [, second, third, clock, yearText] = parts;
  const monthFirst = MONTHS[second ?? ""] !== undefined;
  const month = monthFirst ? MONTHS[second ?? ""] : MONTHS[third ?? ""];
  const dayText = monthFirst ? third : second;
  const time = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(clock ?? "");
  if (month === undefined || !time) return null;
  const day = Number(dayText);
  const year = Number(yearText);
  if (!Number.isInteger(day) || !Number.isInteger(year)) return null;
  return {
    month,
    day,
    hour: Number(time[1]),
    minute: Number(time[2]),
    second: Number(time[3]),
    year,
  };
}

/**
 * The registry's `procStart`, in epoch ms.
 *
 * **It is UTC, and it says so nowhere.** Measured against a live process: the registry reads
 * `Fri Aug 14 17:10:48 2026` for one that `ps` reports as `Fri Aug 14 13:10:48 2026` local, and
 * reading the registry value as UTC makes the two agree exactly. Parsing it as local time instead
 * would put every session five hours out and reject all of them, which fails silently as "no
 * background tasks anywhere".
 */
export function parseRegistryProcStart(text: string): number | null {
  const parts = parseCTime(text);
  if (!parts) return null;
  return Date.UTC(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second);
}

/** `ps -o lstart=`, which unlike the registry really is local time. */
export function parseProcessLstart(text: string): number | null {
  const parts = parseCTime(text);
  if (!parts) return null;
  return new Date(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second)
    .getTime();
}

/** Both sources round to whole seconds, so they agree exactly or the pid was reused. */
const START_TIME_TOLERANCE_MS = 2000;

export function startTimesAgree(registryMs: number, kernelMs: number): boolean {
  return Math.abs(registryMs - kernelMs) <= START_TIME_TOLERANCE_MS;
}
