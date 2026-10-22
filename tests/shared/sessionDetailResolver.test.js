'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  readSessionDetailForPlatform,
  resolveSessionDetailForPlatform,
  runSessionDetailWorker
} = require('../../src/shared/sessionDetailResolver');
const { readSessionDetail: readNativeDetail } = require('../../src/shared/sessionDetail');

function missing(args) {
  return { found: false, client: args.client, sessionId: args.sessionId, exchanges: [] };
}

for (const client of ['codex', 'claude', 'codebuddy', 'workbuddy']) {
  test(`${client} continues WSL fallback when a resolved native or WSL file disappears`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-detail-race-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const homes = ['native', 'wsl-first', 'wsl-next'].map(name => path.join(root, name));
    const sessionId = 'disappearing-session';
    const files = homes.map(home => {
      const dir = client === 'codex'
        ? path.join(home, '.codex', 'sessions')
        : path.join(home, `.${client}`, 'projects', 'test');
      fs.mkdirSync(dir, { recursive: true });
      return path.join(dir, `${sessionId}.jsonl`);
    });
    const turn = JSON.stringify(client === 'codex'
      ? { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 5 } } } }
      : client === 'claude'
        ? { type: 'assistant', message: { usage: { input_tokens: 10, output_tokens: 5 } } }
        : { type: 'message', role: 'assistant', providerData: { messageId: 'response', usage: { input_tokens: 10, output_tokens: 5 } } });
    const openSync = fs.openSync;
    for (const disappearingIndex of [0, 1]) {
      fs.writeFileSync(files[disappearingIndex], turn);
      fs.writeFileSync(files[2], turn);
      const opened = [];
      t.mock.method(fs, 'openSync', (filePath, ...options) => {
        opened.push(filePath);
        if (filePath === files[disappearingIndex]) fs.unlinkSync(filePath);
        return openSync(filePath, ...options);
      });
      const detail = await resolveSessionDetailForPlatform(
        { client, sessionId, period: 'total', sessionCost: 0.25 },
        { platform: 'win32', homedir: () => homes[0], env: {}, wslUsageHomes: () => homes.slice(1) }
      );
      t.mock.restoreAll();
      assert.deepEqual(opened, [files[disappearingIndex], files[2]]);
      assert.equal(detail.found, true);
      assert.equal(detail.totals.totalTokens, 15);
      assert.equal(detail.totals.costUsd, 0.25);
      assert.equal(Object.hasOwn(detail, 'error'), false);
    }
  });
}

test('keeps native and WSL read failures instead of reporting a missing transcript', async () => {
  for (const failingHome of ['/native', '/wsl']) {
    const attempts = [];
    const detail = await resolveSessionDetailForPlatform({ client: 'codex', sessionId: 'large' }, {
      platform: 'win32', homedir: () => '/native',
      wslUsageHomes: () => ['/wsl', '/other'],
      readSessionDetail: args => {
        attempts.push(args.home);
        return args.home === failingHome ? { found: false, error: 'line-too-large' } : missing(args);
      }
    });
    assert.equal(detail.error, 'line-too-large');
    assert.deepEqual(attempts, failingHome === '/native' ? ['/native'] : ['/native', '/wsl']);
  }
});

test('Pi detail reads the scoped WSL scanner root despite a host env override', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-pi-wsl-detail-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nativeHome = path.join(root, 'native');
  const wslHome = path.join(root, 'wsl');
  const dir = path.join(wslHome, '.pi', 'agent', 'sessions', '--project--');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '2026-10-12T00-00-00-000Z_pi-wsl.jsonl'), [
    JSON.stringify({ type: 'message', timestamp: '2026-10-12T00:00:00.000Z', message: { role: 'user', content: 'from Pi WSL' } }),
    JSON.stringify({ type: 'message', timestamp: '2026-10-12T00:00:01.000Z', message: {
      role: 'assistant', content: [], usage: { input: 10, output: 5, cost: { total: 0.25 } }
    } })
  ].join('\n'));
  const detail = await resolveSessionDetailForPlatform({ client: 'pi', sessionId: 'pi-wsl', period: 'total' }, {
    platform: 'win32', homedir: () => nativeHome,
    env: { PI_CODING_AGENT_DIR: path.join(root, 'host-override') }, wslUsageHomes: () => [wslHome]
  });
  assert.equal(detail.found, true);
  assert.equal(detail.exchanges[0].promptPreview, 'from Pi WSL');
  assert.equal(detail.totals.totalTokens, 15);
  assert.equal(detail.totals.costUsd, 0.25);
});

test('OMP detail reads the fixed session root from a discovered WSL home', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-omp-wsl-detail-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nativeHome = path.join(root, 'native');
  const wslHome = path.join(root, 'wsl');
  const sessionId = 'omp-wsl-main';
  const dir = path.join(wslHome, '.omp', 'agent', 'sessions', '-project');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `2026-10-12T00-00-00-000Z_${sessionId}.jsonl`), [
    JSON.stringify({ type: 'title', v: 1, title: 'OMP WSL', pad: '' }),
    JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd: '/project' }),
    JSON.stringify({ type: 'message', timestamp: '2026-10-12T00:00:00.000Z', message: { role: 'user', content: 'from OMP WSL' } }),
    JSON.stringify({ type: 'message', timestamp: '2026-10-12T00:00:01.000Z', message: { role: 'assistant', content: [], usage: { input: 8, output: 4, cost: { total: 0.5 } } } })
  ].join('\n'));
  const detail = await resolveSessionDetailForPlatform({ client: 'omp', sessionId, period: 'total' }, {
    platform: 'win32', homedir: () => nativeHome,
    env: { OMP_PROFILE: path.join(root, 'host-profile'), PI_CODING_AGENT_DIR: path.join(root, 'host-pi') },
    wslUsageHomes: () => [wslHome]
  });
  assert.equal(detail.found, true);
  assert.equal(detail.exchanges[0].promptPreview, 'from OMP WSL');
  assert.equal(detail.totals.totalTokens, 12);
  assert.equal(detail.totals.costUsd, 0.5);
});

test('reads a Claude transcript from a discovered WSL home', async (t) => {
  const nativeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-native-detail-'));
  const wslHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-wsl-detail-'));
  t.after(() => fs.rmSync(nativeHome, { recursive: true, force: true }));
  t.after(() => fs.rmSync(wslHome, { recursive: true, force: true }));
  const sessionId = 'wsl-session';
  const transcriptDir = path.join(wslHome, '.claude', 'projects', '-workspace');
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(path.join(transcriptDir, `${sessionId}.jsonl`), [
    JSON.stringify({ type: 'user', timestamp: '2026-07-31T00:00:00.000Z', message: { content: 'from WSL' } }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-31T00:00:01.000Z',
      message: {
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
        content: []
      }
    })
  ].join('\n'));

  const detail = await resolveSessionDetailForPlatform(
    { client: 'claude', sessionId, period: 'total', sessionCost: 0.25 },
    {
      platform: 'win32',
      homedir: () => nativeHome,
      wslUsageHomes: () => [wslHome]
    }
  );

  assert.equal(detail.found, true);
  assert.equal(detail.exchanges[0].promptPreview, 'from WSL');
  assert.equal(detail.totals.totalTokens, 18);
  assert.equal(detail.totals.costUsd, 0.25);
});

test('WSL Claude detail ignores the host CLAUDE_CONFIG_DIR override', async (t) => {
  const nativeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-native-detail-'));
  const wslHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-wsl-detail-'));
  const hostConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-host-claude-'));
  t.after(() => fs.rmSync(nativeHome, { recursive: true, force: true }));
  t.after(() => fs.rmSync(wslHome, { recursive: true, force: true }));
  t.after(() => fs.rmSync(hostConfigDir, { recursive: true, force: true }));
  const sessionId = 'wsl-scoped-config';
  const transcriptDir = path.join(wslHome, '.claude', 'projects', '-workspace');
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(path.join(transcriptDir, `${sessionId}.jsonl`), [
    JSON.stringify({ type: 'user', timestamp: '2026-07-31T00:00:00.000Z', message: { content: 'from scoped WSL' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-07-31T00:00:01.000Z', message: { usage: { input_tokens: 2, output_tokens: 1 }, content: [] } })
  ].join('\n'));

  const detail = await resolveSessionDetailForPlatform(
    { client: 'claude', sessionId, period: 'total' },
    {
      platform: 'win32',
      homedir: () => nativeHome,
      env: { CLAUDE_CONFIG_DIR: hostConfigDir },
      wslUsageHomes: () => [wslHome]
    }
  );

  assert.equal(detail.found, true);
  assert.equal(detail.exchanges[0].promptPreview, 'from scoped WSL');
  assert.equal(detail.totals.totalTokens, 3);
});

test('reads a Claude transcript from the alternate root in a discovered WSL home', async (t) => {
  const nativeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-native-detail-'));
  const wslHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-wsl-detail-'));
  t.after(() => fs.rmSync(nativeHome, { recursive: true, force: true }));
  t.after(() => fs.rmSync(wslHome, { recursive: true, force: true }));
  const sessionId = 'alternate-wsl-session';
  const transcriptDir = path.join(wslHome, '.claude', 'transcripts');
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(path.join(transcriptDir, `${sessionId}.jsonl`), [
    JSON.stringify({ type: 'user', timestamp: '2026-07-31T00:00:00.000Z', message: { content: 'from alternate root' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-07-31T00:00:01.000Z', message: { usage: { input_tokens: 4, output_tokens: 2 }, content: [] } })
  ].join('\n'));

  const detail = await resolveSessionDetailForPlatform(
    { client: 'claude', sessionId, period: 'total' },
    { platform: 'win32', homedir: () => nativeHome, wslUsageHomes: () => [wslHome] }
  );

  assert.equal(detail.found, true);
  assert.equal(detail.exchanges[0].promptPreview, 'from alternate root');
  assert.equal(detail.totals.totalTokens, 6);
});

test('reads a Codex transcript from its dated path in a discovered WSL home', async (t) => {
  const nativeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-native-detail-'));
  const wslHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-wsl-detail-'));
  t.after(() => fs.rmSync(nativeHome, { recursive: true, force: true }));
  t.after(() => fs.rmSync(wslHome, { recursive: true, force: true }));
  const sessionId = 'rollout-2026-07-31T12-34-56-real-codex';
  const transcriptDir = path.join(wslHome, '.codex', 'sessions', '2026', '07', '31');
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(path.join(transcriptDir, `${sessionId}.jsonl`), [
    JSON.stringify({ type: 'event_msg', timestamp: '2026-07-31T00:00:00.000Z', payload: { type: 'user_message', message: 'from Codex WSL' } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-07-31T00:00:01.000Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, cached_input_tokens: 3, output_tokens: 5, reasoning_output_tokens: 2, total_tokens: 15 } } } })
  ].join('\n'));

  const detail = await resolveSessionDetailForPlatform(
    { client: 'codex', sessionId, period: 'total', sessionCost: 0.1 },
    { platform: 'win32', homedir: () => nativeHome, wslUsageHomes: () => [wslHome] }
  );

  assert.equal(detail.found, true);
  assert.equal(detail.exchanges[0].promptPreview, 'from Codex WSL');
  assert.equal(detail.totals.totalTokens, 15);
  assert.equal(detail.totals.costUsd, 0.1);
});

test('returns a native Claude detail without enumerating WSL homes', async () => {
  let enumerated = false;
  const detail = await resolveSessionDetailForPlatform(
    { client: 'claude', sessionId: 'native' },
    {
      platform: 'win32',
      homedir: () => 'C:\\Users\\me',
      readSessionDetail: (args) => ({ ...missing(args), found: true, home: args.home }),
      wslUsageHomes: () => { enumerated = true; return []; }
    }
  );

  assert.equal(detail.found, true);
  assert.equal(detail.home, 'C:\\Users\\me');
  assert.equal(enumerated, false);
});

test('resolves a Reasonix native detail through the same platform resolver', async () => {
  const nativeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-native-reasonix-detail-'));
  const stateHome = path.join(nativeHome, 'state');
  const sessions = path.join(stateHome, 'projects', 'opaque', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, 'branch.jsonl.meta'), JSON.stringify({ id: 'resolver-id' }));
  fs.writeFileSync(path.join(sessions, 'branch.events.jsonl'), [
    JSON.stringify({ type: 'user.message', ts: '2026-08-08T00:00:00.000Z', text: 'resolver prompt' }),
    JSON.stringify({ type: 'model.final', ts: '2026-08-08T00:00:01.000Z', usage: { prompt_tokens: 3, completion_tokens: 2 } })
  ].join('\n'));
  try {
    const detail = await resolveSessionDetailForPlatform(
      { client: 'reasonix', sessionId: 'reasonix:resolver-id', period: 'total' },
      {
        platform: process.platform,
        homedir: () => nativeHome,
        readSessionDetail: (args) => readNativeDetail({
          ...args,
          deps: { platform: process.platform, env: { REASONIX_STATE_HOME: stateHome } }
        })
      }
    );
    assert.equal(detail.found, true);
    assert.equal(detail.exchanges[0].promptPreview, 'resolver prompt');
    assert.equal(detail.totals.totalTokens, 5);
  } finally {
    fs.rmSync(nativeHome, { recursive: true, force: true });
  }
});

for (const client of ['claude', 'codebuddy', 'codex', 'workbuddy']) {
  test(`falls back to running WSL homes for ${client} JSONL details on Windows`, async () => {
    const homes = [];
    const detail = await resolveSessionDetailForPlatform(
      { client, sessionId: 'wsl-session' },
      {
        platform: 'win32',
        homedir: () => 'C:\\Users\\me',
        readSessionDetail: (args) => {
          homes.push(args.home);
          return args.home.endsWith('\\ubuntu') ? { ...missing(args), found: true, home: args.home } : missing(args);
        },
        wslUsageHomes: () => ['\\\\wsl$\\Ubuntu\\home\\first', '\\\\wsl$\\Ubuntu\\home\\ubuntu']
      }
    );

    assert.equal(detail.found, true);
    assert.equal(detail.home, '\\\\wsl$\\Ubuntu\\home\\ubuntu');
    assert.deepEqual(homes, [
      'C:\\Users\\me',
      '\\\\wsl$\\Ubuntu\\home\\first',
      '\\\\wsl$\\Ubuntu\\home\\ubuntu'
    ]);
  });
}

test('does not inspect WSL homes for non-Windows or SQLite-backed clients', async () => {
  for (const [platform, client] of [['linux', 'claude'], ['win32', 'opencode'], ['linux', 'dsh']]) {
    let enumerated = false;
    const detail = await resolveSessionDetailForPlatform(
      { client, sessionId: 'missing' },
      {
        platform,
        homedir: () => '/native',
        readSessionDetail: missing,
        wslUsageHomes: () => { enumerated = true; return ['should-not-run']; }
      }
    );

    assert.equal(detail.found, false);
    assert.equal(enumerated, false);
  }
});

test('returns the native not-found result when WSL discovery fails', async () => {
  const nativeDetail = { found: false, client: 'claude', sessionId: 'missing', exchanges: [], marker: 'native' };
  const detail = await resolveSessionDetailForPlatform(
    { client: 'claude', sessionId: 'missing' },
    {
      platform: 'win32',
      homedir: () => 'C:\\Users\\me',
      readSessionDetail: () => nativeDetail,
      wslUsageHomes: () => { throw new Error('WSL unavailable'); }
    }
  );

  assert.equal(detail, nativeDetail);
});

test('runs session detail lookup in a worker thread', async () => {
  const detail = await runSessionDetailWorker(
    { expected: 'worker-result' },
    { workerPath: path.join(__dirname, '..', 'fixtures', 'sessionDetailThreadWorker.js') }
  );

  assert.equal(detail.expected, 'worker-result');
  assert.ok(detail.threadId > 0);
});

test('the production worker entry returns session detail', async () => {
  const detail = await readSessionDetailForPlatform({ client: 'hermes', sessionId: 'missing', period: 'total' });

  assert.deepEqual(detail, {
    found: false,
    client: 'hermes',
    sessionId: 'missing',
    period: 'total',
    exchanges: [],
    totals: { totalTokens: 0, costUsd: 0, exchangeCount: 0, turnCount: 0 }
  });
});

test('terminates and rejects a session detail worker that exceeds its deadline', async () => {
  let onTimeout;
  let timeoutDelay;
  let terminated = false;
  class HangingWorker {
    once() { return this; }
    terminate() {
      terminated = true;
      return Promise.resolve(0);
    }
  }

  const result = runSessionDetailWorker(
    { client: 'claude', sessionId: 'blocked-wsl' },
    {
      Worker: HangingWorker,
      timeoutMs: 25,
      setTimeout: (callback, delay) => { onTimeout = callback; timeoutDelay = delay; return 1; },
      clearTimeout: () => {}
    }
  );

  assert.equal(timeoutDelay, 25);
  onTimeout();
  await assert.rejects(result, /Session detail worker timed out after 25ms/);
  assert.equal(terminated, true);
});

test('the public session detail resolver uses the worker boundary', async () => {
  let workerArgs;
  class FakeWorker {
    constructor(_workerPath, options) {
      workerArgs = options.workerData;
      this.listeners = new Map();
      queueMicrotask(() => this.listeners.get('message')?.({ ok: true, detail: { found: false } }));
    }

    once(event, listener) {
      this.listeners.set(event, listener);
      return this;
    }
  }

  const args = { client: 'claude', sessionId: 'missing' };
  const result = readSessionDetailForPlatform(args, {
    Worker: FakeWorker, getPricingRevision: () => { throw new Error('native details must not probe Dots pricing'); }
  });
  assert.ok(result instanceof Promise);
  assert.deepEqual(await result, { found: false });
  assert.equal(workerArgs, args);
});

test('Dots details price from the shared cache and treat a revision change as unpriced until a lookup lands', async () => {
  const { resolveLocalUsagePricing, waitForPricingWarm } = require('../../src/shared/providers/codex/localUsage');
  const models = ['resolver-dots-priced', 'resolver-dots-free'];
  const rates = [{ inputCostPerToken: 0.01 }, { inputCostPerToken: 0 }];
  const makeDetail = () => ({
    found: true, usageSource: 'codex-dots-local', totals: {}, exchanges: [{ turns:
      [...models, 'unknown'].map((model) => ({ model, tokens: { input: 100, total: 100 } }))
    }]
  });
  const workerArgs = [];
  class DotsWorker {
    constructor(_path, options) {
      workerArgs.push(options.workerData);
      this.listeners = new Map();
      queueMicrotask(() => this.listeners.get('message')?.({ ok: true, detail: makeDetail() }));
    }
    once(event, listener) { this.listeners.set(event, listener); return this; }
  }
  let behavior = 'success';
  const lookups = [];
  const lookupModelPricing = async (model, timeout) => {
    lookups.push({ model, timeout });
    if (behavior === 'throw') throw new Error('temporary pricing timeout');
    return { pricing: behavior === 'missing' ? null : rates[models.indexOf(model)] };
  };
  const revision = 'resolver-dots-shared-v1';
  await resolveLocalUsagePricing(models.map((model) => ({ model })), { pricingRevision: revision, lookupModelPricing });
  const args = { client: 'codex', sessionId: 'dots-test', period: 'total' };
  const deps = { Worker: DotsWorker, lookupModelPricing, getPricingRevision: () => {
    assert.ok(workerArgs.length > 0, 'pricing revision is read after the worker result');
    return revision;
  } };
  // The aggregate tick owns the lookups; a detail read only spends what they left.
  behavior = 'throw';
  const aggregateFallback = await readSessionDetailForPlatform(args, deps);
  assert.equal(aggregateFallback.totals.costUsd, 1);
  assert.equal(aggregateFallback.totals.unpricedTokens, 100, 'only the unknown-model request is unpriced');
  assert.equal(aggregateFallback.exchanges[0].turns[0].costEstimate, 1);
  assert.equal(aggregateFallback.exchanges[0].turns[1].costEstimate, 0);
  assert.equal(aggregateFallback.exchanges[0].turns[1].unpricedTokens, undefined, 'explicit zero pricing survives failures');

  const lookupsBeforeDetail = lookups.length;
  await readSessionDetailForPlatform(args, deps);
  assert.equal(lookups.length, lookupsBeforeDetail, 'a priced detail read never spawns the catalog');

  const changedRevision = await readSessionDetailForPlatform(args, { ...deps, pricingRevision: 'resolver-dots-shared-v2' });
  assert.equal(changedRevision.totals.costUsd, 0);
  assert.equal(changedRevision.totals.unpricedTokens, 300, 'old-revision cache is never reused');

  behavior = 'missing';
  await readSessionDetailForPlatform(args, { ...deps, pricingRevision: 'resolver-dots-shared-v2' });
  await waitForPricingWarm();
  const confirmedMissing = await readSessionDetailForPlatform(args, { ...deps, pricingRevision: 'resolver-dots-shared-v2' });
  assert.equal(confirmedMissing.totals.costUsd, 0);
  assert.equal(confirmedMissing.totals.unpricedTokens, 300);
  behavior = 'throw';
  const failureAfterMiss = await readSessionDetailForPlatform(args, { ...deps, pricingRevision: 'resolver-dots-shared-v2' });
  assert.equal(failureAfterMiss.totals.costUsd, 0, 'a confirmed miss does not resurrect an earlier success');
  assert.equal(failureAfterMiss.totals.unpricedTokens, 300);

  // A confirmed miss is retried on its own 30s clock; a new revision asks the
  // catalog again, and the rate it finds prices the next read.
  behavior = 'success';
  const v3 = { ...deps, pricingRevision: 'resolver-dots-shared-v3' };
  await readSessionDetailForPlatform(args, v3);
  await waitForPricingWarm();
  const repriced = await readSessionDetailForPlatform(args, v3);
  assert.equal(repriced.totals.costUsd, 1);
  assert.equal(repriced.totals.unpricedTokens, 100);

  const cached = await resolveLocalUsagePricing(models.map((model) => ({ model })), {
    pricingRevision: revision, lookupModelPricing: () => { throw new Error('warm aggregate must not look up prices'); }
  });
  assert.deepEqual(models.map((model) => cached[model]), rates, 'a found rate survives for its revision');
  assert.ok(lookups.every(({ model, timeout }) => models.includes(model) && timeout === 1500));
  assert.ok(workerArgs.every((value) => value === args), 'pricing stays in main, outside worker data');
});

test('a Pi detail read is never blocked on a catalog lookup', async () => {
  const { waitForPricingWarm } = require('../../src/shared/providers/codex/localUsage');
  const makeDetail = () => ({
    found: true, client: 'pi', totals: {},
    exchanges: [{ costEstimate: 0, turns: [
      { model: 'pi-inline-model', costEstimate: 0, tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 150 } }
    ] }]
  });
  class PiWorker {
    constructor() {
      this.listeners = new Map();
      queueMicrotask(() => this.listeners.get('message')?.({ ok: true, detail: makeDetail() }));
    }
    once(event, listener) { this.listeners.set(event, listener); return this; }
  }
  let finishLookup;
  let lookups = 0;
  const lookupModelPricing = () => {
    lookups += 1;
    return new Promise((resolve) => { finishLookup = resolve; });
  };
  const rates = { inputCostPerToken: 0.000001, outputCostPerToken: 0.000002, cacheReadInputTokenCost: 0, cacheCreationInputTokenCost: 0 };
  const deps = { Worker: PiWorker, lookupModelPricing, getPricingRevision: () => 'pi-nonblocking-v1' };
  const args = { client: 'pi', sessionId: 'nonblocking', period: 'total' };

  // The lookup promise never settles, so a read that awaited it could not return.
  const startedAt = Date.now();
  const first = await readSessionDetailForPlatform(args, deps);
  assert.ok(Date.now() - startedAt < 1000, 'the read does not wait for the catalog');
  assert.equal(first.exchanges[0].turns[0].costEstimate, 0);
  assert.equal(first.exchanges[0].turns[0].unpricedTokens, 150, 'an unknown rate is unpriced, never a share');
  assert.equal(lookups, 1);

  finishLookup({ pricing: rates });
  await waitForPricingWarm();

  const second = await readSessionDetailForPlatform(args, deps);
  assert.ok(Math.abs(second.exchanges[0].turns[0].costEstimate - 0.0002) < 1e-12);
  assert.equal(lookups, 1, 'a priced read reuses the cache instead of spawning again');

  const changed = await readSessionDetailForPlatform(args, { ...deps, getPricingRevision: () => 'pi-nonblocking-v2' });
  assert.equal(changed.exchanges[0].turns[0].costEstimate, 0, 'another revision never reuses the old rate');
  assert.equal(lookups, 2);
  finishLookup(null);
  await waitForPricingWarm();
});

// dsh reads its own transcript format directly, so it always dispatches to
// readDshSessionDetail rather than the tokscale-JSONL reader, and forwards
// home/platform/env/cwdDir the same way the generic `deps.readSessionDetail`
// seam already does.
test('dsh dispatches to readDshSessionDetail with home/platform/env/cwdDir, never the generic JSONL reader', async () => {
  let received;
  const detail = await resolveSessionDetailForPlatform(
    { client: 'dsh', sessionId: 's1' },
    {
      readDshSessionDetail: (args) => { received = args; return { found: true, client: 'dsh', sessionId: 's1' }; },
      readSessionDetail: () => { throw new Error('must not call the generic reader for dsh'); },
      homedir: () => '/home/dsh-tester',
      platform: 'linux',
      env: { DSH_HOME: '/custom/.dsh' },
      cwdDir: '/work'
    }
  );
  assert.deepEqual(detail, { found: true, client: 'dsh', sessionId: 's1' });
  assert.equal(received.home, '/home/dsh-tester');
  assert.equal(received.platform, 'linux');
  assert.deepEqual(received.env, { DSH_HOME: '/custom/.dsh' });
  assert.equal(received.cwdDir, '/work');
});

// wslUsage.js scans `.dsh/sessions` (MARKER_CLIENTS), so a DSH session can
// legitimately surface in the list from a WSL distro on Windows. Detail must
// follow the same native-miss -> WSL-hit fallback claude/codex already get,
// through readDshSessionDetail rather than the tokscale-JSONL reader.
test('falls back to a WSL home for a dsh session not found in the native home', async () => {
  const attempts = [];
  const detail = await resolveSessionDetailForPlatform(
    { client: 'dsh', sessionId: 's1' },
    {
      readDshSessionDetail: (args) => {
        attempts.push(args.home);
        return args.home === '/wsl/home/tester'
          ? { found: true, client: 'dsh', sessionId: 's1', home: args.home }
          : { found: false, client: 'dsh', sessionId: 's1' };
      },
      readSessionDetail: () => { throw new Error('must not call the generic reader for dsh'); },
      homedir: () => 'C:\\Users\\me',
      platform: 'win32',
      wslUsageHomes: () => ['/wsl/home/tester']
    }
  );
  assert.equal(detail.found, true);
  assert.equal(detail.home, '/wsl/home/tester');
  assert.deepEqual(attempts, ['C:\\Users\\me', '/wsl/home/tester']);
});

// dshPaths.js's resolveDshHome checks env.DSH_HOME before the homeDir it is
// given. If the WSL fallback attempt got the host's real env, a host-side
// DSH_HOME override would silently redirect the WSL lookup straight back to
// the host path, making the fallback a no-op — tokscale's own scanner
// deliberately disables env-based root lookup for an explicit --home
// (use_env_roots: false, lib.rs) for exactly this reason.
test('does not let a host DSH_HOME override leak into the WSL fallback attempt', async () => {
  const envSeen = [];
  const detail = await resolveSessionDetailForPlatform(
    { client: 'dsh', sessionId: 's1' },
    {
      readDshSessionDetail: (args) => {
        envSeen.push(args.env);
        return args.home === '/wsl/home/tester'
          ? { found: true, client: 'dsh', sessionId: 's1', home: args.home }
          : { found: false, client: 'dsh', sessionId: 's1' };
      },
      homedir: () => 'C:\\Users\\me',
      platform: 'win32',
      env: { DSH_HOME: 'C:\\custom\\dsh' },
      wslUsageHomes: () => ['/wsl/home/tester']
    }
  );
  assert.equal(detail.found, true);
  assert.deepEqual(envSeen[0], { DSH_HOME: 'C:\\custom\\dsh' }, 'the native attempt should still honor the host DSH_HOME');
  assert.deepEqual(envSeen[1], {}, 'the WSL attempt must not inherit the host DSH_HOME');
});

// The split used to happen in the detail worker, so a main-process pricer that
// only filled zero-cost turns found nothing to fill. These two run the real
// worker and the real resolver seam to keep that ordering covered.
function piHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-resolver-pi-'));
  const dir = path.join(home, '.pi', 'agent', 'sessions', '--D--project--');
  fs.mkdirSync(dir, { recursive: true });
  return { home, dir };
}

// The worker resolves its own home (`os.homedir()`), because the detail reader
// deliberately ignores PI_CODING_AGENT_DIR to stay aligned with the scanner.
async function asHome(home, run) {
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function piAssistant({ model, cost, input = 0, output = 0, cacheRead = 0, timestamp }) {
  return JSON.stringify({
    type: 'message', id: `m-${timestamp}`, parentId: null, timestamp,
    message: {
      role: 'assistant', model, content: [{ type: 'text', text: 'x' }],
      usage: { input, output, cacheRead, cacheWrite: 0, reasoning: 0, cost: { total: cost } }
    }
  });
}

test('a scan-priced Pi session still gets per-turn catalog prices, not a share', async () => {
  const { waitForPricingWarm } = require('../../src/shared/providers/codex/localUsage');
  const { home, dir } = piHome();
  const sessionId = 'resolver-pi-priced';
  fs.writeFileSync(path.join(dir, `2026-10-22T00-00-00-000Z_${sessionId}.jsonl`), [
    JSON.stringify({ type: 'message', id: 'p', timestamp: '2026-10-22T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }),
    // Pi priced this one itself; the catalog must not touch it.
    piAssistant({ model: 'resolver-pi-model', cost: 0.01, input: 100, output: 100, timestamp: '2026-10-22T00:00:02.000Z' }),
    piAssistant({ model: 'resolver-pi-model', cost: 0, input: 200, output: 100, timestamp: '2026-10-22T00:00:03.000Z' })
  ].join('\n'));
  const rates = { inputCostPerToken: 0.000001, outputCostPerToken: 0.000002, cacheReadInputTokenCost: 0, cacheCreationInputTokenCost: 0 };
  const deps = {
    lookupModelPricing: async () => ({ pricing: rates }),
    getPricingRevision: () => 'resolver-pi-priced-v1'
  };
  // sessionCost is what the Sessions row reports for the whole session.
  const args = { client: 'pi', sessionId, period: 'total', sessionCost: 6 };

  try {
    const detail = await asHome(home, async () => {
      await readSessionDetailForPlatform(args, deps);
      await waitForPricingWarm();
      return readSessionDetailForPlatform(args, deps);
    });

    const turns = detail.exchanges[0].turns;
    const sessionTokens = turns.reduce((sum, turn) => sum + turn.tokens.total, 0);
    assert.equal(turns[0].costEstimate, 0.01, 'a reported price is kept as-is');
    // 200 input + 100 output at the catalog rates, not 6 * 300 / 400.
    assert.ok(Math.abs(turns[1].costEstimate - 0.0004) < 1e-12);
    assert.ok(Math.abs(turns[1].costEstimate - 6 * (turns[1].tokens.total / sessionTokens)) > 1e-3, 'never a share of the session subtotal');
    assert.ok(Math.abs(detail.totals.costUsd - 0.0104) < 1e-12);
    assert.equal(detail.totals.unpricedTokens, undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a Pi session whose model the catalog cannot price is unpriced, not split', async () => {
  const { waitForPricingWarm } = require('../../src/shared/providers/codex/localUsage');
  const { home, dir } = piHome();
  const sessionId = 'resolver-pi-unpriced';
  fs.writeFileSync(path.join(dir, `2026-10-22T00-00-00-000Z_${sessionId}.jsonl`), [
    JSON.stringify({ type: 'message', id: 'p', timestamp: '2026-10-22T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }),
    piAssistant({ model: 'resolver-pi-unknown', cost: 0, input: 200, output: 100, timestamp: '2026-10-22T00:00:02.000Z' }),
    piAssistant({ model: 'resolver-pi-unknown', cost: 0, input: 100, output: 50, timestamp: '2026-10-22T00:00:03.000Z' })
  ].join('\n'));
  const deps = {
    lookupModelPricing: async () => null,
    getPricingRevision: () => 'resolver-pi-unpriced-v1'
  };
  const args = { client: 'pi', sessionId, period: 'total', sessionCost: 6 };

  try {
    const detail = await asHome(home, async () => {
      await readSessionDetailForPlatform(args, deps);
      await waitForPricingWarm();
      return readSessionDetailForPlatform(args, deps);
    });

    for (const turn of detail.exchanges[0].turns) {
      assert.equal(turn.costEstimate, 0);
      assert.equal(turn.unpricedTokens, turn.tokens.total);
    }
    assert.equal(detail.totals.costUsd, 0);
    assert.equal(detail.totals.unpricedTokens, 450);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// OMP writes the Pi transcript format and reports costs the same way, so its
// unpriced turns go through the same catalog pricer.
test('an OMP detail gets its zero-cost turns priced from the catalog', async () => {
  const { waitForPricingWarm } = require('../../src/shared/providers/codex/localUsage');
  const makeDetail = () => ({
    found: true, client: 'omp', totals: {},
    exchanges: [{
      costEstimate: 0.02,
      turns: [
        { model: 'omp-reported', costEstimate: 0.02, tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 15 } },
        { model: 'omp-unpriced', costEstimate: 0, tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 150 } }
      ]
    }]
  });
  class OmpWorker {
    constructor() {
      this.listeners = new Map();
      queueMicrotask(() => this.listeners.get('message')?.({ ok: true, detail: makeDetail() }));
    }
    once(event, listener) { this.listeners.set(event, listener); return this; }
  }
  const deps = {
    Worker: OmpWorker,
    lookupModelPricing: async (model) => model === 'omp-unpriced'
      ? { pricing: { inputCostPerToken: 0.000001, outputCostPerToken: 0.000002, cacheReadInputTokenCost: 0, cacheCreationInputTokenCost: 0 } }
      : null,
    getPricingRevision: () => 'resolver-omp-v1'
  };
  const args = { client: 'omp', sessionId: 'omp-seam', period: 'total' };

  await readSessionDetailForPlatform(args, deps);
  await waitForPricingWarm();
  const detail = await readSessionDetailForPlatform(args, deps);

  assert.equal(detail.exchanges[0].turns[0].costEstimate, 0.02, 'a reported price is kept');
  assert.ok(Math.abs(detail.exchanges[0].turns[1].costEstimate - 0.0002) < 1e-12);
  assert.ok(Math.abs(detail.totals.costUsd - 0.0202) < 1e-12);
});
