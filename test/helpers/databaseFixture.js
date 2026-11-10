import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createDatabaseAdapter } from '../../functions/utils/databaseAdapter.js';
import { memoryDatabase } from './loadFunction.js';

// Run the real D1 SQL against SQLite, without requiring a native npm addon.
export function databaseFixture(t, backend = 'KV') {
    let env, seed;
    if (backend === 'KV') {
        const kv = memoryDatabase();
        env = { img_url: kv };
        seed = (id, value, metadata) => kv.records.set(id, { value, metadata: structuredClone(metadata) });
    } else {
        const sqlite = new DatabaseSync(':memory:');
        t.after(() => sqlite.close());
        sqlite.exec(readFileSync(new URL('../../database/init.sql', import.meta.url), 'utf8'));
        env = { img_d1: { prepare(sql) {
            let params = [];
            return {
                bind(...values) { params = values.map(v => v == null ? null : typeof v === 'boolean' ? Number(v) : v); return this; },
                async first() { return sqlite.prepare(sql).get(...params) ?? null; },
                async all() { return { results: sqlite.prepare(sql).all(...params) }; },
                async run() { sqlite.prepare(sql).run(...params); return { success: true }; },
            };
        } } };
        seed = (id, value, metadata) => sqlite.prepare('INSERT OR REPLACE INTO files (id, value, metadata, timestamp) VALUES (?, ?, ?, ?)')
            .run(id, value, JSON.stringify(metadata), metadata.TimeStamp || 1);
    }
    return { env, seed, db: createDatabaseAdapter(env) };
}
