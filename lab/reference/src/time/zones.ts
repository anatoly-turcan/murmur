export function isValidTimezone(name: string): boolean {
  if (name === '' || /^[+-]/.test(name)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    Temporal.Now.zonedDateTimeISO(name);

    return true;
  } catch {
    return false;
  }
}

function zoned(ms: number, tz: string): Temporal.ZonedDateTime {
  return Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(tz);
}

export function localDate(ms: number, tz: string): string {
  return zoned(ms, tz).toPlainDate().toString();
}

export function localMinuteOfDay(ms: number, tz: string): number {
  const z = zoned(ms, tz);

  return z.hour * 60 + z.minute;
}

export function localMidnightMs(date: string, tz: string): number {
  return Temporal.PlainDate.from(date).toZonedDateTime({ timeZone: tz }).epochMilliseconds;
}

export function localTimeMs(date: string, hour: number, tz: string): number {
  const time = new Temporal.PlainTime(hour);

  return Temporal.PlainDate.from(date).toZonedDateTime({ timeZone: tz, plainTime: time }).epochMilliseconds;
}
