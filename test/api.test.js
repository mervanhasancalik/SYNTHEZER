import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_PORT = 9876;
const BASE = `http://localhost:${TEST_PORT}`;

describe('Synthezer API', () => {
  let server;

  before(async () => {
    // Use a temp directory for test database
    const tmpDir = mkdtempSync(join(tmpdir(), 'synthezer-test-'));
    const dbPath = join(tmpDir, 'test.db');

    server = spawn('node', ['serve.js'], {
      env: {
        ...process.env,
        SYNTHEZER_PORT: String(TEST_PORT),
        SYNTHEZER_DB_PATH: dbPath,
      },
      cwd: process.cwd(),
      stdio: 'pipe',
    });

    // Wait for server to be ready
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server start timeout')), 10000);
      server.stdout.on('data', (data) => {
        if (data.toString().includes('localhost')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      server.stderr.on('data', (data) => {
        // Log but don't fail — native module warnings are expected
      });
    });
  });

  after(() => {
    if (server) server.kill();
  });

  it('GET /api/health returns ok', async () => {
    const res = await fetch(`${BASE}/api/health`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'ok');
    assert.ok(data.version);
  });

  it('GET / serves frontend HTML', async () => {
    const res = await fetch(BASE);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type').includes('text/html'));
    assert.ok(res.headers.get('content-security-policy'));
    assert.ok(res.headers.get('x-frame-options'));
  });

  it('GET /api/chips returns chip list', async () => {
    const res = await fetch(`${BASE}/api/chips`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.success);
    // Without category filter, chips are grouped by category as an object
    assert.equal(typeof data.chips, 'object');
    assert.ok(Object.keys(data.chips).length > 0, 'Should have seeded chips');
  });

  it('POST /api/pipeline creates a pipeline', async () => {
    const res = await fetch(`${BASE}/api/pipeline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Pipeline' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.success);
    assert.ok(data.pipeline.id.startsWith('pl_'));
  });

  it('GET /api/pipeline lists pipelines', async () => {
    const res = await fetch(`${BASE}/api/pipeline`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.success);
    assert.ok(Array.isArray(data.pipelines));
    assert.ok(data.pipelines.length >= 1);
  });

  it('GET /api/pipeline/:id returns a specific pipeline', async () => {
    // First create one
    const create = await fetch(`${BASE}/api/pipeline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Get Test' }),
    });
    const { pipeline } = await create.json();

    const res = await fetch(`${BASE}/api/pipeline/${pipeline.id}`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.success);
    assert.equal(data.pipeline.id, pipeline.id);
  });

  it('DELETE /api/pipeline/:id deletes a pipeline', async () => {
    const create = await fetch(`${BASE}/api/pipeline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Delete Test' }),
    });
    const { pipeline } = await create.json();

    const res = await fetch(`${BASE}/api/pipeline/${pipeline.id}`, { method: 'DELETE' });
    assert.equal(res.status, 200);

    const get = await fetch(`${BASE}/api/pipeline/${pipeline.id}`);
    assert.equal(get.status, 404);
  });

  it('GET /api/profile/stats returns stats', async () => {
    const res = await fetch(`${BASE}/api/profile/stats`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.success);
    assert.ok(data.stats.pipelines);
    assert.ok(data.stats.chips);
  });

  it('GET /api/nonexistent returns 404', async () => {
    const res = await fetch(`${BASE}/api/nonexistent`);
    assert.equal(res.status, 404);
  });

  it('security headers are present on frontend', async () => {
    const res = await fetch(BASE);
    assert.ok(res.headers.get('x-content-type-options'));
    assert.ok(res.headers.get('x-frame-options'));
    assert.ok(res.headers.get('referrer-policy'));
    assert.ok(res.headers.get('permissions-policy'));
  });
});
