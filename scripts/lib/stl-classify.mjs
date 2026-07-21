/**
 * Pure classifiers for STL daemon-log analysis.
 *
 * Kept side-effect free (no fs / no top-level work) so the STL engine's behaviour
 * can be unit-tested without executing the whole report-generation script.
 */

/**
 * True when a `response_out` log entry is a CLIENT-side connection abort rather than
 * a genuine server fault. Node/Express logs status 500 with `error: "aborted"` when
 * the socket closes mid-response — e.g. a Claude Code hook process exits (or fires a
 * newer request) before Peon finishes replying. The event is not lost: the client
 * retries and the record lands (the 201s dominate the log). Counting these as
 * "serious recording-path 5xx" cries wolf and has repeatedly skewed the verdict.
 */
export function isClientAbort(e) {
  if (!e || Number(e.status) < 500) return false;
  return /\babort(ed)?\b/i.test(String(e.error || ""));
}

/**
 * True when a `response_out` 500 is a stale-session rejection the client self-heals,
 * rather than a genuine server fault. The daemon throws `Unknown Peon session: <id>`
 * (HTTP 500) when a recording call (`/messages`, `/events`) references a session id it
 * no longer holds — typically because the daemon restarted, or the session index pruned
 * the entry, after the client cached the id. The Claude Code hook's `recordWithSession`
 * catches exactly this message, drops the stale id, recreates the session and retries,
 * so the record still lands (the log shows the 500 immediately followed by
 * `/sessions:201` + `/messages:201`). Surfacing these as "serious recording-path 5xx"
 * cries wolf just like client aborts did, and repeatedly drove the recording-path
 * headline off a self-healed, no-data-loss condition.
 */
export function isStaleSession(e) {
  if (!e || Number(e.status) < 500) return false;
  return /Unknown Peon session/i.test(String(e.error || ""));
}

/**
 * True when a `response_out` is a real server fault we should surface — status >= 500
 * that is neither a client abort nor a self-healed stale-session rejection.
 */
export function isServerFault(e) {
  return !!e && Number(e.status) >= 500 && !isClientAbort(e) && !isStaleSession(e);
}
