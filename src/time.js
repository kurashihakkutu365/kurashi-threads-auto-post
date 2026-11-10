export const SLOTS = [
  ['07:00', 'product'], ['08:10', 'product'], ['10:30', 'daily'],
  ['12:00', 'daily'],
  ['12:20', 'product'], ['16:00', 'daily'], ['17:40', 'product'], ['19:00', 'product'],
];
export function jstDay(now = new Date()) { return new Date(+now + 9 * 3600000).toISOString().slice(0, 10); }
export function jstMonth(now = new Date()) { return jstDay(now).slice(0, 7); }
export function slotsForDay(day) {
  return SLOTS.map(([time, kind]) => ({ id: `${day}/${time}`, kind, scheduledAt: new Date(`${day}T${time}:00+09:00`).toISOString() }));
}
export function slotState(slot, now, graceMinutes) {
  const lag = +now - Date.parse(slot.scheduledAt);
  return lag < 0 ? 'future' : lag > graceMinutes * 60000 ? 'expired' : 'due';
}
