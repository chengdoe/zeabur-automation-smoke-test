export function shanghaiDateString(now = new Date()) {
  const values = shanghaiDateTimeParts(now);
  return `${values.year}-${values.month}-${values.day}`;
}

export function shanghaiDateTimeParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(now);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

export function parseDateOnly(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid date: ${date}`);
  }
  return new Date(`${date}T00:00:00+08:00`);
}

export function weekdayForDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid date: ${date}`);
  }
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}
