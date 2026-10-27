const formatters = new Map();

const getDateFormatter = (timeZone) => {
  if (!formatters.has(timeZone)) {
    formatters.set(
      timeZone,
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }),
    );
  }
  return formatters.get(timeZone);
};

export const dateKeyInTimeZone = (date, timeZone = 'Asia/Kolkata') => {
  const parts = getDateFormatter(timeZone).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
};

export const dateOnlyKey = (value) => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) {
    return null;
  }
  const key = value.slice(0, 10);
  const parsed = new Date(`${key}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== key ? null : key;
};

export const addDaysToDateKey = (dateKey, days) => {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

export const differenceInDateDays = (laterDateKey, earlierDateKey) => {
  const later = new Date(`${laterDateKey}T00:00:00.000Z`).getTime();
  const earlier = new Date(`${earlierDateKey}T00:00:00.000Z`).getTime();
  return Math.round((later - earlier) / 86_400_000);
};
