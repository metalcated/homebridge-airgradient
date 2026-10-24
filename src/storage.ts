import { mkdirSync } from 'fs';
import { join } from 'path';
import type { DatabaseSync as SQLiteDatabase } from 'node:sqlite';
import { Payload } from './device';

// Loaded only when storage is used; no browser state or native add-on is required.
export class SensorStore {
  private readonly db: SQLiteDatabase;

  constructor(root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    this.db = new DatabaseSync(join(root, 'airgradient.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS diagnostics(serial TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY, serial TEXT NOT NULL, time INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS history_sensor_time ON history(serial,time);`);
  }

  diagnostics(serial: string, payload: Payload): void {
    this.db.prepare('INSERT INTO diagnostics VALUES(?,?) ON CONFLICT(serial) DO UPDATE SET payload=excluded.payload')
      .run(serial, JSON.stringify(payload));
  }

  readDiagnostics(serial: string): Payload | undefined {
    const row = this.db.prepare('SELECT payload FROM diagnostics WHERE serial=?').get(serial);
    return row ? JSON.parse(String(row.payload)) : undefined;
  }

  append(serial: string, payload: Payload, retentionDays: number, time = Date.now()): void {
    if (!retentionDays) {
      return;
    }
    this.db.prepare('INSERT INTO history(serial,time,payload) VALUES(?,?,?)').run(serial, time, JSON.stringify(payload));
    this.db.prepare('DELETE FROM history WHERE serial=? AND time<?').run(serial, time - retentionDays * 86400000);
    // Bound disk growth even when a user selects one-second polling.
    this.db.prepare(`DELETE FROM history WHERE serial=? AND id NOT IN
      (SELECT id FROM history WHERE serial=? ORDER BY time DESC,id DESC LIMIT 10000)`).run(serial, serial);
  }

  history(serial: string, limit = 240): Payload[] {
    return this.db.prepare('SELECT time,payload FROM history WHERE serial=? ORDER BY time DESC,id DESC LIMIT ?')
      .all(serial, Math.max(1, Math.min(10000, Math.floor(limit))))
      .map(row => ({ time: row.time, ...JSON.parse(String(row.payload)) }));
  }

  close(): void {
    this.db.close();
  }
}
