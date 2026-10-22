'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { readPiSessionTitle } = require('../../src/shared/providers/pi/sessionMetadata');

function fixture(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-pi-title-'));
  const file = path.join(dir, '2026-01-01T00-00-00-000Z_session.jsonl');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return { dir, file };
}

const header = JSON.stringify({ type: 'session', id: 's1', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/repo' });
const prompt = (text) => JSON.stringify({ type: 'message', message: { role: 'user', content: text } });
const rename = (name) => JSON.stringify({ type: 'session_info', name });

test('a renamed Pi session is labelled by its latest session_info name', (t) => {
  // Pi persists a name only on rename, and an empty one explicitly clears it,
  // which is the rule Pi's own getSessionName applies.
  const renamed = fixture([header, prompt('first thing'), rename('older'), rename('newest')]);
  t.after(() => fs.rmSync(renamed.dir, { recursive: true, force: true }));
  assert.equal(readPiSessionTitle(renamed.file), 'newest');

  const cleared = fixture([header, prompt('first thing'), rename('gone'), rename('')]);
  t.after(() => fs.rmSync(cleared.dir, { recursive: true, force: true }));
  assert.equal(readPiSessionTitle(cleared.file), 'first thing');
});

test('an unrenamed Pi session is labelled like /resume: its first user message', (t) => {
  const text = fixture([header, JSON.stringify({ type: 'model_change', modelId: 'x' }), prompt('first thing'), prompt('second thing')]);
  t.after(() => fs.rmSync(text.dir, { recursive: true, force: true }));
  assert.equal(readPiSessionTitle(text.file), 'first thing');

  // Pi writes prompts as content blocks too, and an assistant reply before the
  // prompt must not become the label.
  const blocks = fixture([header,
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } }),
    JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'block  prompt' }] } })]);
  t.after(() => fs.rmSync(blocks.dir, { recursive: true, force: true }));
  assert.equal(readPiSessionTitle(blocks.file), 'block prompt');

  // An image-only prompt still names the row, the way the detail reader does.
  const image = fixture([header, JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'image', data: 'x' }] } })]);
  t.after(() => fs.rmSync(image.dir, { recursive: true, force: true }));
  assert.equal(readPiSessionTitle(image.file), '[image]');
});

test('a long Pi title is capped, and a transcript with no prompt yields none', (t) => {
  const long = fixture([header, prompt('a'.repeat(200))]);
  t.after(() => fs.rmSync(long.dir, { recursive: true, force: true }));
  const title = readPiSessionTitle(long.file);
  assert.equal(Array.from(title).length, 96);
  assert.ok(title.endsWith('…'));

  const empty = fixture([header]);
  t.after(() => fs.rmSync(empty.dir, { recursive: true, force: true }));
  assert.equal(readPiSessionTitle(empty.file), '');
  assert.equal(readPiSessionTitle(''), '');
});
