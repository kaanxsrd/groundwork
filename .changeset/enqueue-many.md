---
"@vantedev/groundwork": minor
---

Job handles have `enqueueMany(jobs, { tx })`: up to 1,000 jobs of one type in one statement, each with `enqueue`'s options (`runAt`, `delay`, `priority`, `dedupeKey`, `maxAttempts`), and results in the same order. Every job is checked first, so one bad job enqueues none, and the error names it (`jobs[2]: …`). A `dedupeKey` also applies between jobs in the same call: the first is created, and the others get its id.

```ts
await sendReceipt.enqueueMany(
  orders.map((order) => ({ payload: { orderId: order.id }, dedupeKey: `receipt:${order.id}` })),
  { tx },
);
```
