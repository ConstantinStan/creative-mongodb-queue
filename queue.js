// queue.js  —  works with MongoDB server 6.x → 8.x and driver ≥ 6.0
import crypto              from 'crypto';

/* ───────── helpers ───────── */
const _ack      = () => crypto.randomBytes(16).toString('hex');
const _now      = () => new Date();
const _plusSecs = s => new Date(Date.now() + s * 1e3);
const _arr      = x => (Array.isArray(x) ? x : [x]);

// unwrap() makes driver-6+ (doc) and driver-≤5 (ModifyResult) look the same
const unwrap = r => (r && Object.prototype.hasOwnProperty.call(r, 'value') ? r.value : r);

/* ───────── public factory ───────── */
export default async function createQueue(db, name, opts = {}) {
  return Queue.connect(db, name, opts);
}

/* ───────── Queue class ───────── */
class Queue {
  /* static factory */
  static async connect(db, name, {
    visibility = 30,
    delay      = 0,
    deadQueue  = null,
    maxRetries = 5,
    transactionalDLQ = false   // only if your cluster supports transactions
  } = {}) {

    if (!db)   throw new Error('mongodb-queue: supply a mongodb.Db');
    if (!name) throw new Error('mongodb-queue: supply a collection name');

    const q = new Queue(db, name, {
      visibility, delay, deadQueue, maxRetries, transactionalDLQ
    });

    /* idempotent index build */
    await Promise.all([
      q._col.createIndex({ visible: 1, deleted: 1 }),
      q._col.createIndex({ deleted: 1 }, { expireAfterSeconds: 0 }),
      q._col.createIndex({ ack: 1 },     { unique: true, sparse: true })
    ]);

    /* wait until the TTL monitor has seen the new TTL index (nice for tests) */
    await db.admin().command({ setParameter: 1, ttlMonitorSleepSecs: 1 });

    return q;
  }

  /* ctor */
  constructor(db, name, {
    visibility, delay, deadQueue,
    maxRetries, transactionalDLQ
  }) {
    this._col               = db.collection(name);
    this._visibility        = visibility;
    this._delay             = delay;
    this._deadQueue         = deadQueue;
    this._maxRetries        = maxRetries;
    this._txnDLQ            = transactionalDLQ;
    this._client            = db.client;          // for transactions
  }

  /* ── produce ───────────────────────────────────────── */

  async add(payload, { delay = this._delay } = {}) {
    const visible = delay ? _plusSecs(delay) : _now();
    const docs    = _arr(payload).map(p => ({ payload: p, visible, tries: 0 }));
    const { insertedIds } = await this._col.insertMany(docs, { ordered: false });
    const ids = Object.values(insertedIds).map(x => x.toHexString());
    return Array.isArray(payload) ? ids : ids[0];
  }

  addBulk(payloads, opts = {}) { return this.add(payloads, opts); }

  async scheduleAt(date, payload, opts = {}) {
    const when  = typeof date === 'string' ? new Date(date) : date;
    const delay = Math.max(0, Math.floor((when - Date.now()) / 1000));
    return this.add(payload, { ...opts, delay });
  }

  async scheduleRecurring(cron, payload, opts = {}) {
    return this.add({ originalPayload: payload, recurrence: { pattern: cron, createdAt: _now() } }, opts);
  }

  /* ── consume ───────────────────────────────────────── */

  async get({ visibility = this._visibility } = {}) {
    const query  = { deleted: null, visible: { $lte: _now() } };
    const update = { $inc: { tries: 1 }, $set: { ack: _ack(), visible: _plusSecs(visibility) } };

    const res = await this._col.findOneAndUpdate(
      query,
      update,
      { sort: { _id: 1 }, returnDocument: 'after', includeResultMetadata: false }
    );
    const msg = unwrap(res);
    if (!msg) return null;

    /* dead-letter check */
    if (this._deadQueue && msg.tries > this._maxRetries) {
      await this._moveToDLQ(msg);         // will recurse for next msg
      return this.get({ visibility });
    }

    return {
      id:      msg._id.toHexString(),
      ack:     msg.ack,
      payload: msg.payload,
      tries:   msg.tries
    };
  }

  async ping(ack, { visibility = this._visibility } = {}) {
    const res = await this._col.findOneAndUpdate(
      { ack, visible: { $gt: _now() }, deleted: null },
      { $set: { visible: _plusSecs(visibility) } },
      { returnDocument: 'after', includeResultMetadata: false }
    );
    const doc = unwrap(res);
    if (!doc) throw new Error(`Queue.ping(): unknown ack ${ack}`);
    return doc._id.toHexString();
  }

  async ack(ack) {
    const res = await this._col.findOneAndUpdate(
      { ack, visible: { $gt: _now() }, deleted: null },
      { $set: { deleted: _now() } },
      { returnDocument: 'after', includeResultMetadata: false }
    );
    const doc = unwrap(res);
    if (!doc) throw new Error(`Queue.ack(): unknown ack ${ack}`);
    return doc._id.toHexString();
  }

  /* ── metrics ───────────────────────────────────────── */

  total    () { return this._col.estimatedDocumentCount(); }
  size     () { return this._col.countDocuments({ deleted: null, visible: { $lte: _now() } }); }
  inFlight () { return this._col.countDocuments({ ack: { $exists: true }, visible: { $gt: _now() }, deleted: null }); }
  done     () { return this._col.countDocuments({ deleted: { $exists: true } }); }

  /* ── internals ─────────────────────────────────────── */

  async _moveToDLQ(msg) {
    if (!this._deadQueue) return;

    /* transaction is optional but recommended from MongoDB 7+ */
    if (this._txnDLQ && this._client?.startSession) {
      const session = this._client.startSession();
      try {
        await session.withTransaction(async () => {
          await this._deadQueue._col.insertOne(msg, { session });
          await this._col.updateOne({ _id: msg._id }, { $set: { deleted: _now() } }, { session });
        });
      } finally { await session.endSession(); }
    } else {
      await this._deadQueue._col.insertOne(msg);
      await this._col.updateOne({ _id: msg._id }, { $set: { deleted: _now() } });
    }
  }
}
