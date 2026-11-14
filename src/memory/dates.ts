// Turns natural-language dates into UTC ranges for the user's local calendar.
// `now` and `timeZone` are injected so tests never depend on the machine clock.

export interface DateRange {
  from: string; // ISO, inclusive
  to: string; // ISO, exclusive
  label: string;
}

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_PATTERN = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

interface CalendarDate { year: number; month: number; day: number }

function validTimeZone(value: string): string {
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return value; }
  catch { return "UTC"; }
}

function localParts(date: Date, timeZone: string): CalendarDate & { hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const number = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return { year: number("year"), month: number("month"), day: number("day"), hour: number("hour"), minute: number("minute"), second: number("second") };
}

// Intl exposes zone offsets only indirectly. Two passes handle offset changes around DST.
function localMidnight(date: CalendarDate, timeZone: string): Date {
  const wallClock = Date.UTC(date.year, date.month - 1, date.day);
  let instant = wallClock;
  for (let i = 0; i < 2; i++) {
    const seen = localParts(new Date(instant), timeZone);
    const seenAsUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second);
    instant -= seenAsUtc - wallClock;
  }
  return new Date(instant);
}

function addDays(date: CalendarDate, days: number): CalendarDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function dayRange(date: CalendarDate, label: string, timeZone: string): DateRange {
  return {
    from: localMidnight(date, timeZone).toISOString(),
    to: localMidnight(addDays(date, 1), timeZone).toISOString(),
    label,
  };
}

function monthIndex(value: string): number {
  const prefix = value.toLowerCase().slice(0, 3);
  return MONTH_NAMES.findIndex((month) => month.startsWith(prefix));
}

export function resolveDate(text: string, now = new Date(), requestedTimeZone = "UTC"): DateRange | null {
  const t = text.toLowerCase();
  const timeZone = validTimeZone(requestedTimeZone);
  const today = localParts(now, timeZone);
  const calendarToday: CalendarDate = { year: today.year, month: today.month, day: today.day };

  // Specific relative phrases must precede their shorter substrings.
  if (/\b(?:the )?day before yesterday\b/.test(t) || /\btwo days ago\b/.test(t)) {
    return dayRange(addDays(calendarToday, -2), "two days ago", timeZone);
  }
  if (/\b(?:a|one) week ago\b/.test(t)) return dayRange(addDays(calendarToday, -7), "a week ago", timeZone);

  // Explicit dates take priority over words such as "today" elsewhere in the request.
  const explicit =
    t.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?[ .-]+(${MONTH_PATTERN})(?:[ ,.-]+(\\d{4}))?\\b`)) ??
    t.match(new RegExp(`\\b(${MONTH_PATTERN})[ .-]+(\\d{1,2})(?:st|nd|rd|th)?(?:[ ,.-]+(\\d{4}))?\\b`));
  if (explicit) {
    const dayFirst = /^\d/.test(explicit[1]);
    const day = Number(dayFirst ? explicit[1] : explicit[2]);
    const month = monthIndex(dayFirst ? explicit[2] : explicit[1]) + 1;
    let year = Number(explicit[3] || today.year);
    const candidate = { year, month, day };
    const valid = month > 0 && day > 0 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (valid) {
      if (!explicit[3] && localMidnight(candidate, timeZone).getTime() > now.getTime()) year -= 1;
      return dayRange({ year, month, day }, `${day} ${MONTH_NAMES[month - 1]}`, timeZone);
    }
  }

  // “last week” is the previous Monday-to-Monday local calendar range.
  if (/\blast week\b/.test(t)) {
    const weekday = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
    const daysSinceMonday = (weekday + 6) % 7;
    const fromDate = addDays(calendarToday, -daysSinceMonday - 7);
    return {
      from: localMidnight(fromDate, timeZone).toISOString(),
      to: localMidnight(addDays(fromDate, 7), timeZone).toISOString(),
      label: "last week",
    };
  }

  // “last Tuesday” is strictly in the past; “on Tuesday” may mean today.
  const weekdayMatch = t.match(new RegExp(`\\b(last|on) (${DAYS.join("|")})\\b`));
  if (weekdayMatch) {
    const target = DAYS.indexOf(weekdayMatch[2]);
    const current = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
    let back = (current - target + 7) % 7;
    if (weekdayMatch[1] === "last" && back === 0) back = 7;
    return dayRange(addDays(calendarToday, -back), `${weekdayMatch[1]} ${weekdayMatch[2]}`, timeZone);
  }

  if (/\byesterday\b/.test(t)) return dayRange(addDays(calendarToday, -1), "yesterday", timeZone);
  if (/\btoday\b/.test(t)) return dayRange(calendarToday, "today", timeZone);
  return null;
}
