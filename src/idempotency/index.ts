/**
 * `@vante/groundwork/idempotency`: Idempotency-Key handling with stored responses.
 *
 * ```ts
 * import { createIdempotency } from "@vante/groundwork/idempotency";
 *
 * const idempotency = createIdempotency({ db, table: idempotencyKeys, secret });
 *
 * export async function POST(request: Request) {
 *   return idempotency.handle(request, { scope: `user:${user.id}` }, async () => {
 *     const order = await createOrder(await request.json());
 *     return Response.json(order, { status: 201 });
 *   });
 * }
 *
 * // Anything that isn't an HTTP handler, such as a webhook event:
 * const result = await idempotency.run({ scope: "stripe", key: event.id }, () => fulfil(event));
 * ```
 *
 * @module
 */
export {
  IDEMPOTENCY_KEY_HEADER,
  type IdempotencyErrorCode,
  parseIdempotencyKey,
  REPLAYED_HEADER,
} from "./http.ts";
export { createIdempotency, type IdempotencyOptions } from "./idempotency.ts";
export type { HandleOptions, Idempotency, Jsonify, RunInput, RunResult } from "./types.ts";
