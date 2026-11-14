# groomrs-snow-model API documentation

These documents are for clients of the snow-model HTTP API (contract `groomrs-snow-model/v1`). They explain how to call each endpoint and what comes back. For running and developing the service itself, see the [top-level README](../README.md).

| Document                                  | Read it for                                                                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Overview](api/overview.md)               | Base URL, conventions (units, times, seasons), versioning and the end-to-end workflow.                                                                              |
| [Endpoints](api/endpoints.md)             | Every endpoint: parameters, request bodies, status codes and example responses.                                                                                     |
| [Jobs](api/jobs.md)                       | The asynchronous job lifecycle, idempotency, polling, `blocked` and `failed` reasons.                                                                               |
| [Result document](api/result-document.md) | Field-by-field reference for the forecast result: forcing, SNOWPACK series, layer profiles.                                                                         |
| [Errors](api/errors.md)                   | Error body shape and every error code the API returns.                                                                                                              |
| [Observations](observations.md)           | Concept guide: how grooming, snowmaking and base-depth observations are stored, amended and applied to the managed snowpack, and what SNOWPACK can and cannot take. |

Start with the overview. The API documents are the reference for every route and field; [Observations](observations.md) explains the ideas behind the managed snowpack (why grooming runs one day at a time, how a base-depth reading becomes machine snow) and links back to the reference for the details.

[`GET /v1/schema`](api/endpoints.md#get-v1schema) serves JSON Schema for the job request bodies, the observation batch body and the result document, generated from `src/contract/v1.ts`. Other response bodies are described only in these documents.
