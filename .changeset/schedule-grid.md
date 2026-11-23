---
"@vantedev/groundwork": minor
---

Schedules keep to a grid and tolerate a caller that's slightly early. **This changes when schedules run:**

- The next tick is the previous slot plus `every`, not the time the last tick ran plus `every`. Poll lag no longer adds up: a `"1m"` schedule under a worker polling every 5 seconds used to drift to roughly one tick every 60–65 seconds.
- A tick is due up to `min(every / 10, 5s)` early. A cron that calls `runOnce` every minute, a moment before a `"1m"` schedule's slot, used to run it only every other minute. It now runs every time.
- As before, missed slots aren't replayed: after an outage the next tick runs at once, and the grid restarts from there. `trigger(name)` restarts the grid too.
