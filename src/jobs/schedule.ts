import { DateTime } from "luxon";
import { AirtableClient } from "../airtable/airtableClient.js";
import { PostFields } from "../airtable/fields.js";
import { Logger } from "../logger.js";
import { jitterMs } from "../utils/crypto.js";

type Post = Record<string, unknown>;

const makeSlotsForDay = (day: DateTime, hours: number[]) =>
  hours.map((h) => day.set({ hour: h, minute: 0, second: 0, millisecond: 0 }));

const buildIntervalHours = (startHour: number, endHour: number, intervalHours: number) => {
  const hours: number[] = [];
  for (let h = startHour; h < endHour; h += intervalHours) hours.push(h);
  return hours;
};

export const scheduleJob = async (params: {
  airtable: AirtableClient;
  postsTableName: string;
  logger: Logger;
  timezone: string;
  scheduleMode: "batch" | "windows" | "interval";
  batchSlotHours: number[];
  intervalHours: number;
  windowStartHour: number;
  windowEndHour: number;
  targetMin: number;
  targetMax: number;
}) => {
  const now = DateTime.now().setZone(params.timezone);

  const scheduledToday = await params.airtable.listAll<Post>(params.postsTableName, {
    filterByFormula: `AND({${PostFields.PostStatus}}="Scheduled", {${PostFields.ScheduledAt}}!="")`,
    maxRecords: 100,
    fields: [PostFields.ScheduledAt]
  });
  const publishedToday = await params.airtable.listAll<Post>(params.postsTableName, {
    filterByFormula: `AND({${PostFields.PostStatus}}="Published", {${PostFields.PublishedAt}}!="")`,
    maxRecords: 100,
    fields: [PostFields.PublishedAt]
  });

  const startOfDay = now.startOf("day");
  const endOfDay = now.endOf("day");

  const scheduledTodayDts = scheduledToday
    .map((p) => DateTime.fromISO(String(p.fields?.[PostFields.ScheduledAt] ?? "")).setZone(params.timezone))
    .filter((dt) => dt.isValid && dt >= startOfDay && dt <= endOfDay);
  const publishedTodayDts = publishedToday
    .map((p) => DateTime.fromISO(String(p.fields?.[PostFields.PublishedAt] ?? "")).setZone(params.timezone))
    .filter((dt) => dt.isValid && dt >= startOfDay && dt <= endOfDay);

  const alreadyCount = scheduledTodayDts.length + publishedTodayDts.length;

  const unscheduled = await params.airtable.listAll<Post>(params.postsTableName, {
    filterByFormula: `AND({${PostFields.PostStatus}}="Generated", {${PostFields.ScheduledAt}}="")`,
    maxRecords: 50,
    fields: [PostFields.ScheduledAt]
  });

  if (unscheduled.length === 0) {
    await params.logger.log({
      level: "INFO",
      subsystem: "SCHEDULE",
      message: `Schedule: no Generated posts to schedule`,
      meta: { alreadyCount, mode: params.scheduleMode }
    });
    return;
  }

  if (params.scheduleMode === "interval" || params.scheduleMode === "batch") {
    const slotHours =
      params.scheduleMode === "batch"
        ? params.batchSlotHours
        : buildIntervalHours(params.windowStartHour, params.windowEndHour, params.intervalHours);

    const todaysSlots = makeSlotsForDay(now, slotHours);
    const tomorrowSlots = makeSlotsForDay(now.plus({ days: 1 }).startOf("day"), slotHours);
    const allSlots = [...todaysSlots, ...tomorrowSlots];

    // occupied keys (minute-granularity)
    const occupied = new Set(scheduledTodayDts.map((dt) => dt.toFormat("yyyy-LL-dd'T'HH:mm")));

    // allow the current slot if we're slightly late (so `run once` at slot time publishes immediately)
    const minTime = now.minus({ minutes: 10 });
    const availableSlots = allSlots
      .filter((dt) => dt.isValid && dt >= minTime)
      .filter((dt) => !occupied.has(dt.toFormat("yyyy-LL-dd'T'HH:mm")))
      .map((dt) => dt.plus({ milliseconds: jitterMs(0, 10 * 60 * 1000) })); // small jitter

    const scheduleCount = Math.min(unscheduled.length, availableSlots.length);
    if (scheduleCount === 0) {
      await params.logger.log({
        level: "INFO",
        subsystem: "SCHEDULE",
        message: `Schedule: no available slots (mode=${params.scheduleMode})`,
        meta: { slotHours, alreadyCount }
      });
      return;
    }

    for (let i = 0; i < scheduleCount; i++) {
      const post = unscheduled[i]!;
      const scheduledAt = availableSlots[i]!;
      await params.airtable.updateRecord(params.postsTableName, post.id, {
        [PostFields.ScheduledAt]: scheduledAt.toISO(),
        [PostFields.PostStatus]: "Scheduled"
      } as any);
    }

    await params.logger.log({
      level: "INFO",
      subsystem: "SCHEDULE",
      message: `Schedule: newly_scheduled=${scheduleCount}, mode=${params.scheduleMode}`,
      meta: { scheduleCount, slotHours }
    });
    return;
  }

  // windows mode (legacy): schedule into two windows with spacing; keep existing daily target logic.
  const range = Math.max(1, params.targetMax - params.targetMin + 1);
  const dailyTarget = params.targetMin + (now.ordinal % range);
  if (alreadyCount >= dailyTarget) {
    await params.logger.log({
      level: "INFO",
      subsystem: "SCHEDULE",
      message: `Schedule(windows): already_today=${alreadyCount} meets target_today=${dailyTarget}`,
      meta: { alreadyCount, dailyTarget }
    });
    return;
  }

  const withinWindow = (dt: DateTime, startHour: number, endHour: number) => dt.hour >= startHour && dt.hour < endHour;
  const nextWindowStart = (t: DateTime) => {
    const morningStart = t.set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
    const morningEnd = t.set({ hour: 12, minute: 0, second: 0, millisecond: 0 });
    const eveningStart = t.set({ hour: 18, minute: 0, second: 0, millisecond: 0 });
    const eveningEnd = t.set({ hour: 21, minute: 0, second: 0, millisecond: 0 });
    if (t < morningStart) return morningStart;
    if (t >= morningStart && t < morningEnd) return t.plus({ minutes: 10 });
    if (t < eveningStart) return eveningStart;
    if (t >= eveningStart && t < eveningEnd) return t.plus({ minutes: 10 });
    return morningStart.plus({ days: 1 });
  };

  const scheduledExisting = await params.airtable.listAll<Post>(params.postsTableName, {
    filterByFormula: `AND({${PostFields.ScheduledAt}}!="", {${PostFields.PostStatus}}="Scheduled")`,
    sortField: PostFields.ScheduledAt,
    sortDirection: "desc",
    maxRecords: 1,
    fields: [PostFields.ScheduledAt]
  });

  let lastScheduled = scheduledExisting[0]?.fields?.[PostFields.ScheduledAt]
    ? DateTime.fromISO(String(scheduledExisting[0].fields[PostFields.ScheduledAt])).setZone(params.timezone)
    : undefined;

  const remaining = Math.max(1, dailyTarget - alreadyCount);
  const toSchedule = unscheduled.slice(0, remaining);
  let newlyScheduled = 0;

  for (const post of toSchedule) {
    const base = lastScheduled ? lastScheduled.plus({ hours: 2, minutes: 20 }) : nextWindowStart(now);
    let scheduledAt = base;
    if (!withinWindow(scheduledAt, 10, 12) && !withinWindow(scheduledAt, 18, 21)) scheduledAt = nextWindowStart(scheduledAt);
    scheduledAt = scheduledAt.plus({ milliseconds: jitterMs(0, 25 * 60 * 1000) });
    if (scheduledAt < now.plus({ minutes: 5 })) scheduledAt = now.plus({ minutes: 5 });

    await params.airtable.updateRecord(params.postsTableName, post.id, {
      [PostFields.ScheduledAt]: scheduledAt.toISO(),
      [PostFields.PostStatus]: "Scheduled"
    } as any);
    lastScheduled = scheduledAt;
    newlyScheduled += 1;
  }

  await params.logger.log({
    level: "INFO",
    subsystem: "SCHEDULE",
    message: `Schedule(windows): newly_scheduled=${newlyScheduled}, already_today=${alreadyCount}, target_today=${dailyTarget}`,
    meta: { newlyScheduled, alreadyCount, dailyTarget }
  });
};
