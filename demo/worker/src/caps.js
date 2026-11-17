// Spend caps. These are code, not prompts: the approval agent reads attacker-controlled pages,
// so it must never be the only thing between a stranger and the GPU budget.
//
// Request time (POST /request): refuse early, before any email is sent.
// Admission time (approval -> booting): db.admitToBooting() re-checks concurrency and the daily
// total atomically; a demo that does not fit waits as `queued` until the sweep admits it.

export function requestCapError(counts, caps) {
  if (counts.ipRecent >= caps.requestsPerIpHour) return "Too many requests from your network. Please try again later.";
  if (counts.pendingForEmail >= 3) return "We already sent you a confirmation link. Please check your inbox.";
  if (counts.emailRecent >= 1) return `You have had a demo in the last ${caps.perEmailDays} days. Please get in touch if you need another one.`;
  if (counts.domainRecent >= 1) return "Someone from your company already requested a demo today. Please try again tomorrow.";
  if (counts.dailyTotal >= caps.dailyTotal) return "Today's demo machines are all taken. Please try again tomorrow.";
  return null;
}

/** Pure mirror of admitToBooting()'s condition, for tests and the sweep's queue logic. */
export const canAdmit = ({ active, startedToday }, caps) => active < caps.maxConcurrent && startedToday < caps.dailyTotal;
