---
"@vantedev/groundwork": minor
---

`audit.query({ offset })` skips that many entries, for admin pages with page numbers, with `count()` for the total. Up to 100,000, and not together with `cursor`. Unlike cursors, offsets can show an entry twice or skip one while the log grows.
