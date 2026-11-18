# 0025: Remind me about an alert

- Status: accepted
- Date: 2026-11-15

## Context

The user sees an alert that can wait, and wants to come back to it later: "tomorrow
morning", "this evening", or a date and time they pick. Achtung should resurface the alert
then, and keep that in the alert's history.

Achtung already resurfaces occurrences: a `resent` event moves `lastEventAt`, so every
client shows the occurrence as unread again and notifies (ADR 0009), and notifications
survive restarts of the app (ADR 0013, ADR 0018). There are no users (ADR 0002), so
anything the server stores is shared by everyone who uses it.

## Decision

- **Reminders live on the server.** A reminder held only by the client could be private,
  but it couldn't be in the alert's history, and it would be lost with the Mac or missed
  while the app is closed. On the server it's in the history, and the alert resurfaces on
  time whether or not any Mac is awake. Without users, a reminder is everyone's: every
  client sees it, it resurfaces the alert for all of them, and anyone can change or cancel
  it. Nobody knows who set it.
- **One pending reminder per occurrence**, in a `reminders` table (occurrence id, due
  time). Setting another replaces it. `PUT /api/occurrences/{id}/reminder` with
  `{ "remindAt": "…" }` sets it, and `DELETE` cancels it. Both return the occurrence, which
  carries `remindAt`, its pending reminder's time or null. The time must be in the future
  and at most a year ahead, or the request is a 400. The client turns "tomorrow morning"
  into an instant in the user's time zone. The server stores instants only.
- **Three new event kinds.** `reminder_set` (with the time, in the event's new `remindAt`)
  and `reminder_cancelled` are in the history, but aren't news: they leave `lastEventAt`
  and `lastEventKind` alone, so setting a reminder doesn't make the alert unread or move
  it up the list for anyone. `reminded`, recorded when the reminder comes due, is news,
  like `resent`: it moves `lastEventAt`, so the occurrence is unread again everywhere, comes
  first in the lists and notifies. An occurrence's `lastEventKind` can be `reminded` but
  never one of the other two. The API has a separate enum for it.
- **The sweep.** `main.ts` runs `remindDue` every 30 seconds, and once at startup. It claims one due reminder at a time
  (`select … for update skip locked`, longest overdue first), deletes it and records
  `reminded` in the same transaction. A reminder comes due once: a crash before the
  commit leaves it pending for the next sweep, and a second server sweeping at the same
  time skips the row that is claimed rather than firing it again. There is one replica
  today (ADR 0014), but the sweep doesn't depend on that. One transaction per reminder
  keeps the lock order the same as ingest's (an occurrence is locked alone), so the sweep
  can't deadlock with an ingest that locks several occurrences. A reminder that was due
  while the server was down comes due on the first sweep after it starts, with the time of
  that sweep, so clients see it as new.
- **What the reminder does with the alert's state.** It reminds whatever the state is
  by then. "Get back to it" holds for an alert that has resolved since, so it reminds
  anyway, with the occurrence showing as resolved. A resend before the due time leaves the
  reminder in place. A re-fire is a new occurrence. The reminder stays on the occurrence it
  was set on, whose history lists the alert's other occurrences. Silences and the ignored
  alert names (ADR 0011) don't stop a reminder: someone asked for it explicitly.
- **The client notifies of a reminder whatever its notification rules would leave out**
  (severity, silence, ignored name, resolved), for the same reason. It still notifies once,
  only when unread and after the baseline, and the notification says "Reminder:".
- **No snoozed state.** Setting a reminder doesn't hide anything. The client marks the
  alert read when the user sets the reminder, which takes it out of the unread list, and
  shows when the reminder is due.

## Consequences

- Someone else's reminder resurfaces an alert for everyone, and notifies everyone who
  runs the app. That follows from having no users. If that becomes noise, revisit it
  together with ADR 0002.
- A reminder comes due up to 30 seconds late on the server. The server announces it on
  the change stream (ADR 0019), as it does a reminder set or cancelled, so a connected
  client shows it at once; one that polls sees it on its next refresh.
- A `reminded` event moves `lastEventAt`, so the next resend comes an hour after it
  (ADR 0009), not an hour after the previous resend.
- Old clients reject an event or `lastEventKind` they don't know (the generated enums are
  closed), so the client that knows the new kinds ships in the same change as the server.
  The client updates itself (ADR 0021) and so usually runs ahead of the server: it reads
  an occurrence without `remindAt` as one without a reminder, and when the server answers
  404 for the reminder route it says the server is too old to remind.
- The presets are constants in the client (`ReminderPreset`): later today is in 3 hours,
  a morning is 08:00 and an evening 18:00 on the user's clock, next week is the next
  Monday morning. A preset with nothing to offer is left out: this evening once it is
  evening, later today when that is tomorrow.
- A reminder set or cancelled elsewhere doesn't move `lastEventAt`. Another client's
  refresh re-reads the newest page of a list whatever changed, as it does for a silence's
  end, so the marker shows there for alerts on that page, and for older ones when their
  list is loaded again. The reminder coming due does move it, and reaches every client.
- Deleting an occurrence would have to delete its reminder first (a foreign key). Nothing
  deletes occurrences today.
