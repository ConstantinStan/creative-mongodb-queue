# Creative MongoDB Queue

A lightweight **at‑least‑once** job‑queue backed by MongoDB 6‑8 and the official Node driver ≥ 6.0.

* Simple FIFO semantics
* Visibility‑timeout locking (SQS‑style)
* Built‑in dead‑letter queue & automatic TTL cleanup
* `scheduleAt()` and `scheduleRecurring()` helpers
* Supports transactions when moving messages to the DLQ

---

\## Table of Contents

1. [Requirements](#requirements)
2. [Installation](#installation)
3. [Quick Start](#quick-start)
4. [API Reference](#api-reference)
5. [Running Workers at Scale](#running-workers-at-scale)  
6. [Design Notes](#design-notes)  
7. [Roadmap](#roadmap)  
8. [Contributing](#contributing)  
9. [License](#license)

---

\## Requirements

|  Component       |  Version                     |
| ---------------- | ---------------------------- |
|  MongoDB         |  ≥ 6.0 (recommended 7 or 8)  |
|  Node.js         |  ≥ 18 (LTS)                  |
|  mongodb driver  |  ≥ 6.0                       |

The library is ESM‑first but also works under CommonJS (`require`).

---

\## Installation

```bash
npm i mongodb-queue-lite    # package name in your project
```

---

\## Quick Start

```js
import { MongoClient } from "mongodb";
import createQueue      from "mongodb-queue-lite";   // path/to/queue.js if local

const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();

const db    = client.db("mydb");
const queue = await createQueue(db, "jobs", {
  visibility: 30,        // seconds a job is locked after get()
  delay:      0,         // default publish delay
});

// Producer
await queue.add({ type: "email", to: "user@example.com" });

// Consumer (simplest form)
const job = await queue.get();
if (job) {
  console.log("payload", job.payload);
  await queue.ack(job.ack);
}
```

For a **production worker** with graceful shutdown and in‑process concurrency, see [`examples/worker.js`](#running-workers-at-scale).

---

\## API Reference

### `createQueue(db, name, [options]) → Promise<Queue>`

Initialises the collection (creates indexes if needed) and returns a `Queue` instance.

| Option             | Type      | Default | Description                                          |
| ------------------ | --------- | ------- | ---------------------------------------------------- |
| `visibility`       | `number`  | `30`    | Seconds a job stays invisible after `get()`          |
| `delay`            | `number`  | `0`     | Default publish delay for `add()`                    |
| `deadQueue`        | `Queue`   | –       | Another `Queue` instance used as DLQ                 |
| `maxRetries`       | `number`  | `5`     | Retries before a message is dead‑lettered            |
| `transactionalDLQ` | `boolean` | `false` | Move to DLQ inside a transaction (replica sets only) |

---

\### Producer methods

|  Method                                 |  Returns                   |  Description                                                                                     |
| --------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------ |
| `add(payload, [o])`                     | `_id` string or `string[]` | Publish one or many jobs. `o.delay` overrides default.                                           |
| `addBulk(array, [o])`                   | `string[]`                 | Alias for `add()` with an array payload.                                                         |
| `scheduleAt(date, payload, [o])`        | `_id`                      | Run once in the future (`Date` or ISO string).                                                   |
| `scheduleRecurring(cron, payload, [o])` | `_id`                      | Store a template job with a cron pattern. Requires an external scheduler that materialises jobs. |

\### Consumer methods

|  Method          |  Returns                                  |  Description                                                                      |
| ---------------- | ----------------------------------------- | --------------------------------------------------------------------------------- |
| `get([o])`       | `{ id, ack, payload, tries }` —or— `null` | Atomically lock and fetch the next visible job. `o.visibility` overrides default. |
| `ack(ack)`       | `_id`                                     | Mark job done (TTL will purge).                                                   |
| `ping(ack, [o])` | `_id`                                     | Extend visibility timeout.                                                        |

\### Introspection

* `total()` – total documents.
* `size()` – ready jobs (`deleted:null && visible≤now`).
* `inFlight()` – locked jobs.
* `done()` – processed jobs (marked `deleted`).

---

\## Running Workers at Scale

The library plays nicely with **PM2** cluster mode:

```bash
# One process per vCPU on a 2‑core VPS
pm2 start worker.js -i 2
```

Inside each process you can run multiple jobs concurrently using a semaphore like **p‑limit**:

```js
const limit = pLimit(process.env.WORKER_CONCURRENCY || 4);
limit(() => processJob(job));
```

See [`examples/worker.js`](./worker.js) for a full implementation.

---

\## Design Notes

* \*\*Dates as native \*\*\`\` – `visible` and `deleted` are stored as Mongo dates, enabling fast range scans and a TTL index (`expireAfterSeconds:0`).
* **findOneAndUpdate** uses `returnDocument:'after'` and `includeResultMetadata:false` which is the modern driver API (≥6.0).
* **Dead‑letter queue** – after `maxRetries`, the message is moved to the DLQ (optionally inside a transaction) and removed from the live queue.
* **Recurring jobs** are templates; a separate scheduler should materialise the next run. This keeps queue operations O(1).

---

\## Roadmap

*

---

\## Contributing

1. Fork 🚀
2. Create a feature branch
3. `npm test`
4. Open a PR

All code ships under ESLint + Prettier; pre‑commit hooks enforce style.

---

\## License

MIT © 2025 Constantin Stan
