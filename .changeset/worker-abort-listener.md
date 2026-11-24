---
"@vantedev/groundwork": patch
---

`jobs.work({ signal })` no longer adds an abort listener to `signal` on every idle poll. A long-running worker used to leak one listener per poll (about 86,400 a day at a 1-second poll), until Node warned about a possible memory leak.
