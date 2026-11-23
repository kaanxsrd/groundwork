---
"@vantedev/groundwork": minor
---

Jobs and schedules take a fixed retry ladder: `backoff: { delays: ["30s", "2m", "10m", "30m", "1h"] }`. After the n-th failed attempt the job waits the n-th delay exactly, with no jitter, and once the list runs out the last delay repeats. It's checked when the job is defined: 1 to 100 valid durations, and not together with `base` or `max`. `BackoffOptions` is now a union of the two forms, so an interface that extended it needs to become a type.
