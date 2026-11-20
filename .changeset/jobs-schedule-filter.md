---
"@vantedev/groundwork": minor
---

`jobs.list({ schedule })` lists one or more schedules' runs by name, and every job record has `schedule`, the schedule's name, or `null` for an enqueued job. The jobs docs also explain why an external cron on the same period as a schedule can run it only every other time.
