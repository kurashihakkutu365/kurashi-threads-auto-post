import { DatabaseSync } from 'node:sqlite';
import { mkdirSync,chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export class Store {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path,0o600);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS products (number INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, canonical TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, product_id TEXT NOT NULL, hash TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, data TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS posts (slot TEXT NOT NULL, sns TEXT NOT NULL, state TEXT NOT NULL, kind TEXT NOT NULL, canonical TEXT, product_id TEXT, text TEXT, scheduled_at TEXT NOT NULL, started_at TEXT NOT NULL, published_at TEXT, container_id TEXT, remote_id TEXT, reason TEXT, PRIMARY KEY(slot,sns));
      CREATE INDEX IF NOT EXISTS history ON posts(canonical, published_at);
      CREATE TABLE IF NOT EXISTS usage (id TEXT PRIMARY KEY, month TEXT NOT NULL, day TEXT NOT NULL, category TEXT NOT NULL, service TEXT NOT NULL, state TEXT NOT NULL, reserved REAL NOT NULL CHECK(reserved>=0), estimated REAL NOT NULL DEFAULT 0 CHECK(estimated>=0), actual_billed REAL, tokens INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, sns TEXT NOT NULL, comment_id TEXT NOT NULL, author TEXT NOT NULL, data TEXT NOT NULL, state TEXT NOT NULL, due_at TEXT NOT NULL, detected_at TEXT NOT NULL, sent_at TEXT, reason TEXT, UNIQUE(sns,comment_id));
      CREATE TABLE IF NOT EXISTS opt_outs (sns TEXT NOT NULL, author TEXT NOT NULL, PRIMARY KEY(sns,author));
      CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY, at TEXT NOT NULL, code TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      PRAGMA user_version=1;`);
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  saveProduct(p, now = new Date()) {
    this.db.prepare(`INSERT INTO products(id,canonical,data,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET canonical=excluded.canonical,data=excluded.data,updated_at=excluded.updated_at`).run(p.id, p.canonical, JSON.stringify(p), now.toISOString());
    return this.product(p.id);
  }
  product(id) {
    const r = this.db.prepare('SELECT * FROM products WHERE id=?').get(id);
    return r && { ...JSON.parse(r.data), number: r.number };
  }
  products() { return this.db.prepare('SELECT id FROM products ORDER BY number DESC').all().map(r => this.product(r.id)); }
  saveImage(i) { this.db.prepare('INSERT INTO images VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET product_id=excluded.product_id,hash=excluded.hash,data=excluded.data').run(i.id, i.productId, i.hash, JSON.stringify(i)); }
  images(id) { return this.db.prepare('SELECT data FROM images WHERE product_id=?').all(id).map(r => JSON.parse(r.data)); }
  cached(key, now = new Date()) { const r = this.db.prepare('SELECT data FROM cache WHERE key=? AND expires_at>?').get(key, now.toISOString()); return r && JSON.parse(r.data); }
  cache(key, value, expiresAt) { this.db.prepare('INSERT INTO cache VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at').run(key, JSON.stringify(value), expiresAt); }
  setting(key, value) {
    if (value !== undefined) this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data').run(key, JSON.stringify(value));
    const r = this.db.prepare('SELECT data FROM settings WHERE key=?').get(key);
    return r && JSON.parse(r.data);
  }
  post(slot, sns) { return this.db.prepare('SELECT * FROM posts WHERE slot=? AND sns=?').get(slot, sns); }
  history(sns,{since,kind,exceptSlot}={}) {
    const rows=this.db.prepare('SELECT slot,kind,text FROM posts WHERE sns=? AND started_at>=? AND text IS NOT NULL ORDER BY started_at').all(sns,since);
    return rows.filter(r=>(!kind||r.kind===kind)&&(!exceptSlot||r.slot!==exceptSlot)).map(r=>r.text);
  }
  updatePost(slot, sns, state, fields = {}) {
    const allowed = ['text', 'container_id', 'remote_id', 'published_at', 'reason'];
    if (Object.keys(fields).some(k => !allowed.includes(k))) throw new Error('invalid_post_update');
    this.db.prepare(`UPDATE posts SET state=?${Object.keys(fields).map(k => `, ${k}=?`).join('')} WHERE slot=? AND sns=?`).run(state, ...Object.values(fields), slot, sns);
  }
  recentlyUsed(canonical, now, days, exceptSlot) {
    // Ambiguous and active attempts reserve the canonical product too; the other SNS in the same slot is allowed.
    return !!this.db.prepare(`SELECT 1 FROM posts WHERE canonical=? AND slot<>? AND started_at>=? AND state IN ('preparing','prepared','sending','unknown','published') LIMIT 1`).get(canonical, exceptSlot, new Date(+now - days * 86400000).toISOString());
  }
  claim(slot, sns, p, now, config) {
    return this.transaction(() => {
      if (this.post(slot.id, sns)) return false;
      if (p && this.recentlyUsed(p.canonical, now, config.duplicateDays, slot.id)) throw new Error('duplicate_product');
      const from = new Date(`${slot.id.slice(0,10)}T00:00:00+09:00`).toISOString();
      const to = new Date(Date.parse(from) + 86400000).toISOString();
      const n = this.db.prepare(`SELECT COUNT(*) n FROM posts WHERE sns=? AND scheduled_at>=? AND scheduled_at<? AND state IN ('preparing','prepared','sending','unknown','published','dry_run')`).get(sns, from, to).n;
      if (n >= config.dailyPostLimit) throw new Error('daily_post_limit');
      const kindCount = this.db.prepare(`SELECT COUNT(*) n FROM posts WHERE sns=? AND kind=? AND scheduled_at>=? AND scheduled_at<? AND state IN ('preparing','prepared','sending','unknown','published','dry_run')`).get(sns,slot.kind,from,to).n;
      if (kindCount >= (slot.kind==='product'?5:3)) throw new Error('daily_kind_limit');
      this.db.prepare('INSERT INTO posts(slot,sns,state,kind,canonical,product_id,scheduled_at,started_at) VALUES(?,?,?,?,?,?,?,?)').run(slot.id,sns,'preparing',slot.kind,p?.canonical ?? null,p?.id ?? null,slot.scheduledAt,now.toISOString());
      return true;
    });
  }
  log(code, now = new Date()) {
    // Store fixed error codes only: never response bodies, tokens or raw comments.
    this.db.prepare('INSERT INTO logs(at,code) VALUES(?,?)').run(now.toISOString(), /^[a-z0-9_]{1,80}$/.test(code) ? code : 'internal_error');
  }
  cleanup(now, days) {
    const cutoff = new Date(+now - days * 86400000).toISOString();
    this.transaction(() => {
      this.db.prepare('DELETE FROM logs WHERE at<?').run(cutoff);
      this.db.prepare('DELETE FROM cache WHERE expires_at<?').run(now.toISOString());
      // Keep dedupe tombstones and rights evidence; erase comment PII, not event identity.
      this.db.prepare("UPDATE events SET data='{}',author='' WHERE detected_at<? AND state IN ('sent','excluded','dry_run')").run(cutoff);
    });
  }
}
