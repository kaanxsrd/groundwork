---
"@vantedev/groundwork": patch
---

A `cost: 0` check (a peek) no longer starts a fixed window, or restarts an expired one, in any store. It reads the state and writes nothing, as documented. Before, a peek on a new subject started its window, so the window ended earlier than the first real request's would have.
