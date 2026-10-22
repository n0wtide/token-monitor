'use strict';

const fs = require('node:fs');
const { resolvePiSessionsDir } = require('./paths');
const { findTimestampedSessionFiles } = require('../../sessionFiles');
const { piPromptText } = require('../../sessionDetail');

// Pi persists a session name only when the user renames it: the latest
// `session_info` entry wins, and an empty one clears it — the same rule Pi's
// own `getSessionName` applies. A session that was never renamed is labelled
// the way Pi's `/resume` list labels it: its first user message.
//
// Only the head and the tail of the transcript are read; the first prompt is at
// the top and a rename is normally recent. shortcut: a rename older than the
// tail window is missed once the file has grown past it, and the first prompt
// labels the row instead.
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 128 * 1024;
const TITLE_MAX_CODE_POINTS = 96;

// Outlives one collection tick so an idle transcript is not re-read every tick.
// One entry per file, rewritten when its size or mtime changes.
const titleCache = new Map();

function cleanTitle(value) {
  const collapsed = String(value || '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(collapsed);
  return chars.length <= TITLE_MAX_CODE_POINTS
    ? collapsed
    : `${chars.slice(0, TITLE_MAX_CODE_POINTS - 1).join('')}…`;
}

function readWindow(filePath, start, length) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(length);
    const bytes = fs.readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, bytes).toString('utf8');
  } catch (_) {
    return '';
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    }
  }
}

// A bounded read can cut a record in half; dropping that line keeps the partial
// JSON from counting as an unparseable entry.
function scanWindow(text, edge) {
  const lines = text.split(/\r?\n/);
  const usable = edge === 'head' ? lines.slice(0, -1) : edge === 'tail' ? lines.slice(1) : lines;
  let name;
  let firstPrompt = '';
  for (const line of usable) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch (_) { continue; }
    if (!entry || typeof entry !== 'object') continue;
    if (entry.type === 'session_info') {
      const value = typeof entry.name === 'string' ? entry.name.trim() : '';
      name = value || undefined;
      continue;
    }
    if (entry.type !== 'message' || firstPrompt) continue;
    if (!entry.message || entry.message.role !== 'user') continue;
    firstPrompt = piPromptText(entry.message.content) || '';
  }
  return { name, firstPrompt };
}

function readPiSessionTitle(filePath) {
  let stat;
  try { stat = fs.statSync(filePath); } catch (_) { return ''; }
  const cacheKey = `${stat.size}:${stat.mtimeMs}`;
  const cached = titleCache.get(filePath);
  if (cached?.key === cacheKey) return cached.title;

  const whole = stat.size <= HEAD_BYTES;
  const head = scanWindow(readWindow(filePath, 0, HEAD_BYTES), whole ? 'whole' : 'head');
  const tail = whole ? {} : scanWindow(readWindow(filePath, stat.size - TAIL_BYTES, TAIL_BYTES), 'tail');
  const title = cleanTitle(tail.name || head.name || head.firstPrompt || tail.firstPrompt || '');
  titleCache.set(filePath, { key: cacheKey, title });
  return title;
}

function resolveSessionMetadata(sessionIds, context) {
  const { metadata, home } = context;
  const result = new Map();
  const sessionsDir = resolvePiSessionsDir({ homeDir: home });
  for (const [sessionId, filePath] of findTimestampedSessionFiles(sessionsDir, sessionIds)) {
    // Timestamps and the workspace ride along: `fileSessionMetadata` reads the
    // `cwd` Pi writes in the session header.
    const meta = context.fileSessionMetadata(sessionId, filePath, metadata.get(`pi:${sessionId}`));
    const title = readPiSessionTitle(filePath);
    result.set(sessionId, { ...meta, ...(title ? { title } : {}) });
  }
  return result;
}

module.exports = { readPiSessionTitle, resolveSessionMetadata };
