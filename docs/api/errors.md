# Errors

## Error body

Errors raised by the API's own validation share one shape:

```json
{
  "error": "bad_request",
  "message": "season 2026 is not a northern season id (use 2025-26)"
}
```

| Field     | Type   | Description                                                         |
| --------- | ------ | ------------------------------------------------------------------- |
| `error`   | string | Stable, machine-readable code. Branch on this.                      |
| `message` | string | Human-readable explanation. Its wording may change; don't parse it. |
| `details` | any    | Optional extra data, for example the conflicting job id on a `409`. |

Validation messages for request bodies name the offending field:

```json
{
  "error": "bad_request",
  "message": "✖ Too big: expected number to be <=168\n  → at horizonHours"
}
```

## Error codes

| Status | `error`                | Returned by                           | Meaning                                                                                             |
| ------ | ---------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `400`  | `bad_request`          | weather, initialize, refresh, results | A parameter or body field is missing, malformed or out of range.                                    |
| `404`  | `not_found`            | any endpoint with an id               | No such resort, job, result, run or file. Malformed UUIDs are also `404`.                           |
| `409`  | `idempotency_conflict` | initialize, refresh                   | The `idempotencyKey` was already used for a different request. `details.jobId` is the existing job. |
| `502`  | `weather_unavailable`  | weather                               | Open-Meteo could not supply the requested window.                                                   |
| `503`  | (none)                 | `/health`                             | A dependency is down. The body is the normal health document with `ok: false`.                      |

Example `409`:

```json
{
  "error": "idempotency_conflict",
  "message": "idempotency key initialize/vail-co/2025-26 was already used for a different request (job 9465f067-3c87-4485-bb32-0d1af5c3fd6c)",
  "details": { "jobId": "9465f067-3c87-4485-bb32-0d1af5c3fd6c" }
}
```

## Framework errors

Some malformed requests are rejected by the HTTP framework (Fastify) before they reach the API, and use Fastify's body instead:

```json
{
  "statusCode": 400,
  "code": "FST_ERR_CTP_INVALID_JSON_BODY",
  "error": "Bad Request",
  "message": "Body is not valid JSON but content-type is set to 'application/json'"
}
```

This happens for invalid JSON (`FST_ERR_CTP_INVALID_JSON_BODY`), an empty body sent with `content-type: application/json` (`FST_ERR_CTP_EMPTY_JSON_BODY`), a content type other than JSON or plain text (`415`, `FST_ERR_CTP_INVALID_MEDIA_TYPE`), and unknown routes (`404`, no `code`). Unexpected server errors return `500` in the same format. Clients should treat any non-2xx response as an error and read `error`/`message` if they're present.

## Errors inside jobs

Problems found while a job runs (an uninitialized season, missing weather, a SNOWPACK crash) don't come back as HTTP errors. The job finishes as `blocked` or `failed`, with an `error` object. See [Jobs](jobs.md#blocked-reasons).
