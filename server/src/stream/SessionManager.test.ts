import type { IChannelDB } from '@/db/interfaces/IChannelDB.js';
import type { ISettingsDB } from '@/db/interfaces/ISettingsDB.js';
import type { ChannelOrmWithTranscodeConfig } from '@/db/schema/derivedTypes.js';
import type { HlsOptions } from '@/ffmpeg/builder/constants.js';
import type { EventService } from '@/services/EventService.js';
import type { OnDemandChannelService } from '@/services/OnDemandChannelService.js';
import type { Logger } from '@/util/logging/LoggerFactory.js';
import type { DeepRequired } from 'ts-essentials';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionConcatStreamMode } from '@tunarr/types/schemas';
import { SessionConcatStreamModes } from '@tunarr/types/schemas';
import type { HlsSessionOptions } from './hls/HlsSession.ts';

// Mock modules that create circular dependency chains through Inversify
vi.mock('@/services/EventService.js', () => ({
  EventService: vi.fn(),
}));

vi.mock('@/services/OnDemandChannelService.js', () => ({
  OnDemandChannelService: vi.fn(),
}));

// Must be imported after the mocks are set up
const { SessionManager } = await import('./SessionManager.ts');
const { BaseHlsSession } = await import('./hls/BaseHlsSession.ts');

// ---------------------------------------------------------------------------
// Stub session: a minimal HlsSession-like object that lets us control
// start/stop behaviour and manually emit events.
// ---------------------------------------------------------------------------

class StubHlsSession extends BaseHlsSession<HlsSessionOptions> {
  public readonly sessionType: 'hls' | 'hls_direct_v2';

  constructor(
    channel: ChannelOrmWithTranscodeConfig,
    options: HlsSessionOptions,
  ) {
    super(channel, options);
    this.sessionType = options.streamMode;
  }

  protected getHlsOptions(): DeepRequired<HlsOptions> {
    return {
      hlsDeleteThreshold: 3,
      streamNameFormat: 'stream.m3u8',
      subtitleStreamNameFormat: 'subs.m3u8',
      segmentNameFormat: 'data%06d.ts',
      segmentBaseDirectory: '/tmp/test-sessions',
      streamBasePath: 'test',
      streamBaseUrl: '/test/',
      hlsTime: 4,
      hlsListSize: 0,
      deleteThreshold: null,
      appendSegments: true,
    };
  }

  // Skip all real startup work — just mark as started
  protected override async startInternal() {
    this.state = 'started';
  }

  protected override async stopInternal() {
    this.state = 'stopped';
  }

  // Skip waiting for stream files
  protected override async waitForStreamReady() {
    const { Result } = await import('@/types/result.js');
    return Result.success(void 0);
  }

  // Use the real Session.isStale() implementation so staleness
  // tests exercise the actual threshold logic.
}

/** A session whose stream never becomes ready. */
class NeverReadySession extends StubHlsSession {
  protected override async waitForStreamReady() {
    const { Result } = await import('@/types/result.js');
    const { GenericError } = await import('@/types/errors.js');
    return Result.failure<void>(new GenericError('stream never became ready'));
  }
}

/** A session that throws out of startInternal. */
class FailingStartSession extends StubHlsSession {
  protected override async startInternal() {
    throw new Error('ffmpeg could not be spawned');
  }
}

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------

const noopLogger = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  trace: vi.fn(),
  warn: vi.fn(),
  setBindings: vi.fn(),
  child: () => noopLogger,
  bindings: () => ({}),
} as unknown as Logger;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const channelUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeChannel(): ChannelOrmWithTranscodeConfig {
  return {
    uuid: channelUuid,
    number: 1,
    transcodeConfig: {},
  } as unknown as ChannelOrmWithTranscodeConfig;
}

function makeSessionManager(
  hlsFactory: (
    channel: ChannelOrmWithTranscodeConfig,
    options: HlsSessionOptions,
  ) => StubHlsSession,
) {
  const channelDB: Partial<IChannelDB> = {
    getChannelOrm: vi.fn().mockResolvedValue(makeChannel()),
  };

  const onDemandService: Partial<OnDemandChannelService> = {
    resumeChannel: vi.fn().mockResolvedValue(undefined),
    pauseChannel: vi.fn().mockResolvedValue(undefined),
  };

  const eventService: Partial<EventService> = {
    push: vi.fn(),
  };

  const settingsDB: Partial<ISettingsDB> = {
    ffmpegSettings: vi.fn().mockReturnValue({
      transcodeDirectory: '/tmp/test-sessions',
    }),
  };

  // Construct SessionManager directly, bypassing Inversify
  const manager = new (SessionManager as any)(
    channelDB,
    onDemandService,
    hlsFactory,
    vi.fn(), // hlsSlowerSessionFactory — not used in these tests
    vi.fn(), // concatSessionFactory
    vi.fn(), // etvNextSessionFactory
    eventService,
    settingsDB,
  ) as SessionManager;

  // Override the @InjectLogger() property with a noop mock so
  // tests don't require an initialized LoggerFactory.
  (manager as any).logger = noopLogger;

  return manager;
}

const connection = { ip: '127.0.0.1' };

describe('SessionManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // A session that never became ready must not be handed to a client. Both
  // failure paths have to leave the session in 'error', because that is what
  // getOrCreateSession reads to decide whether to serve it.
  describe('readiness and startup failures', () => {
    it('does not report a session started when the stream never becomes ready', async () => {
      const manager = makeSessionManager(
        (channel, options) => new NeverReadySession(channel, options),
      );

      const result = await manager.getOrCreateHlsSession(
        channelUuid,
        'token-a',
        connection,
        { streamMode: 'hls' },
      );

      expect(result.isFailure()).toBe(true);
      expect(result.error.message).toContain('stream never became ready');
    });

    it('surfaces the error a session threw while starting', async () => {
      const manager = makeSessionManager(
        (channel, options) => new FailingStartSession(channel, options),
      );

      const result = await manager.getOrCreateHlsSession(
        channelUuid,
        'token-a',
        connection,
        { streamMode: 'hls' },
      );

      expect(result.isFailure()).toBe(true);
      expect(result.error.message).toContain('ffmpeg could not be spawned');
    });

    // HLS sessions never emit 'stop', so the failed session stays in the map.
    // The next request must replace it rather than reuse it.
    it('replaces a session that failed to start on the next request', async () => {
      const created: StubHlsSession[] = [];
      const manager = makeSessionManager((channel, options) => {
        const session =
          created.length === 0
            ? new FailingStartSession(channel, options)
            : new StubHlsSession(channel, options);
        created.push(session);
        return session;
      });

      const first = await manager.getOrCreateHlsSession(
        channelUuid,
        'token-a',
        connection,
        { streamMode: 'hls' },
      );
      expect(first.isFailure()).toBe(true);

      await vi.advanceTimersByTimeAsync(0);

      const second = await manager.getOrCreateHlsSession(
        channelUuid,
        'token-b',
        connection,
        { streamMode: 'hls' },
      );

      expect(second.isSuccess()).toBe(true);
      expect(created).toHaveLength(2);
    });
  });

  describe('session replacement race condition', () => {
    it('replaces a stopping session with one that has its own directory', async () => {
      class SlowStopHlsSession extends StubHlsSession {
        readonly stopGate = Promise.withResolvers<void>();

        protected override async stopInternal() {
          await this.stopGate.promise;
        }
      }

      const sessions: SlowStopHlsSession[] = [];
      const manager = makeSessionManager((channel, options) => {
        const s = new SlowStopHlsSession(channel, options);
        sessions.push(s);
        return s;
      });

      await manager.getOrCreateHlsSession(channelUuid, 'token-a', connection, {
        streamMode: 'hls',
      });
      const sessionA = sessions[0];
      expect(sessionA).toBeDefined();
      if (!sessionA) return;

      // Simulates an ffmpeg that has not exited yet.
      const stopA = sessionA.stop();
      await vi.waitFor(() => expect(sessionA.state).toBe('stopping'));

      await manager.getOrCreateHlsSession(channelUuid, 'token-b', connection, {
        streamMode: 'hls',
      });
      const sessionB = sessions[1];
      expect(sessionB).toBeDefined();
      if (!sessionB) return;

      expect(manager.getHlsSession(channelUuid)).toBe(sessionB);
      expect(sessionB.workingDirectory).not.toBe(sessionA.workingDirectory);

      sessionA.stopGate.resolve();
      await stopA;
      expect(sessionA.state).toBe('stopped');
      sessionA.emit('cleanup');
      expect(manager.getHlsSession(channelUuid)).toBe(sessionB);
    });

    it('endSession does not block a tune-in while the old session stops', async () => {
      class SlowStopHlsSession extends StubHlsSession {
        readonly stopGate = Promise.withResolvers<void>();

        protected override async stopInternal() {
          await this.stopGate.promise;
        }
      }

      const sessions: SlowStopHlsSession[] = [];
      const manager = makeSessionManager((channel, options) => {
        const s = new SlowStopHlsSession(channel, options);
        sessions.push(s);
        return s;
      });

      await manager.getOrCreateHlsSession(channelUuid, 'token-a', connection, {
        streamMode: 'hls',
      });
      const sessionA = sessions[0];
      expect(sessionA).toBeDefined();
      if (!sessionA) return;

      const endA = manager.endSession(channelUuid, 'hls');
      await vi.waitFor(() => expect(sessionA.state).toBe('stopping'));
      expect(manager.getHlsSession(channelUuid)).toBeUndefined();

      // Must resolve while Session A's stop is still pending.
      const resultB = await manager.getOrCreateHlsSession(
        channelUuid,
        'token-b',
        connection,
        { streamMode: 'hls' },
      );
      expect(resultB.isSuccess()).toBe(true);
      expect(manager.getHlsSession(channelUuid)).toBe(sessions[1]);

      sessionA.stopGate.resolve();
      await endA;
      expect(sessionA.state).toBe('stopped');
      expect(manager.getHlsSession(channelUuid)).toBe(sessions[1]);
    });

    it('endSessionInBackground resolves before the session finishes stopping', async () => {
      class SlowStopHlsSession extends StubHlsSession {
        readonly stopGate = Promise.withResolvers<void>();

        protected override async stopInternal() {
          await this.stopGate.promise;
        }
      }

      const sessions: SlowStopHlsSession[] = [];
      const manager = makeSessionManager((channel, options) => {
        const s = new SlowStopHlsSession(channel, options);
        sessions.push(s);
        return s;
      });

      await manager.getOrCreateHlsSession(channelUuid, 'token-a', connection, {
        streamMode: 'hls',
      });
      const sessionA = sessions[0];
      expect(sessionA).toBeDefined();
      if (!sessionA) return;

      // Would hang if this awaited the stop, which is gated below.
      await manager.endSessionInBackground(sessionA);

      expect(manager.getHlsSession(channelUuid)).toBeUndefined();
      await vi.waitFor(() => expect(sessionA.state).toBe('stopping'));

      sessionA.stopGate.resolve();
      await vi.waitFor(() => expect(sessionA.state).toBe('stopped'));
    });

    it('stop event from Session A does not delete Session B at the same key', async () => {
      // Track which sessions the factory creates so we can reference them
      const sessions: StubHlsSession[] = [];
      const manager = makeSessionManager((channel, options) => {
        const s = new StubHlsSession(channel, options);
        sessions.push(s);
        return s;
      });

      // Create Session A
      const resultA = await manager.getOrCreateHlsSession(
        channelUuid,
        'token-a',
        connection,
        { streamMode: 'hls' },
      );
      expect(resultA.isSuccess()).toBe(true);
      const sessionA = sessions[0]!;
      expect(manager.getHlsSession(channelUuid)).toBe(sessionA);

      // End Session A through the manager (simulates user stopping stream)
      await manager.endSession(channelUuid, 'hls');
      expect(manager.getHlsSession(channelUuid)).toBeUndefined();

      // Create Session B at the same key (user starts stream again)
      const resultB = await manager.getOrCreateHlsSession(
        channelUuid,
        'token-b',
        connection,
        { streamMode: 'hls' },
      );
      expect(resultB.isSuccess()).toBe(true);
      const sessionB = sessions[1]!;
      expect(sessionB).not.toBe(sessionA);
      expect(manager.getHlsSession(channelUuid)).toBe(sessionB);

      // Session A's delayed 'stop' event fires (stale event from the old session)
      sessionA.emit('stop');

      // Session B must still be in the map — the identity guard prevents deletion
      expect(manager.getHlsSession(channelUuid)).toBe(sessionB);
    });

    it('cleanup event from Session A does not delete Session B at the same key', async () => {
      const sessions: StubHlsSession[] = [];
      const manager = makeSessionManager((channel, options) => {
        const s = new StubHlsSession(channel, options);
        sessions.push(s);
        return s;
      });

      // Create Session A
      await manager.getOrCreateHlsSession(channelUuid, 'token-a', connection, {
        streamMode: 'hls',
      });
      const sessionA = sessions[0]!;

      // End Session A
      await manager.endSession(channelUuid, 'hls');

      // Create Session B
      await manager.getOrCreateHlsSession(channelUuid, 'token-b', connection, {
        streamMode: 'hls',
      });
      const sessionB = sessions[1]!;
      expect(manager.getHlsSession(channelUuid)).toBe(sessionB);

      // Session A's delayed 'cleanup' event fires
      sessionA.emit('cleanup');

      // Session B must still be in the map
      expect(manager.getHlsSession(channelUuid)).toBe(sessionB);
    });

    it('stop event from the current session DOES remove it from the map', async () => {
      const sessions: StubHlsSession[] = [];
      const manager = makeSessionManager((channel, options) => {
        const s = new StubHlsSession(channel, options);
        sessions.push(s);
        return s;
      });

      await manager.getOrCreateHlsSession(channelUuid, 'token-a', connection, {
        streamMode: 'hls',
      });
      const sessionA = sessions[0]!;
      expect(manager.getHlsSession(channelUuid)).toBe(sessionA);

      // The session's own stop event should still clean up normally
      sessionA.emit('stop');

      expect(manager.getHlsSession(channelUuid)).toBeUndefined();
    });

    it('cleanup event from the current session DOES remove it from the map', async () => {
      const sessions: StubHlsSession[] = [];
      const manager = makeSessionManager((channel, options) => {
        const s = new StubHlsSession(channel, options);
        sessions.push(s);
        return s;
      });

      await manager.getOrCreateHlsSession(channelUuid, 'token-a', connection, {
        streamMode: 'hls',
      });
      const sessionA = sessions[0]!;
      expect(manager.getHlsSession(channelUuid)).toBe(sessionA);

      sessionA.emit('cleanup');

      expect(manager.getHlsSession(channelUuid)).toBeUndefined();
    });
  });

  describe('connection staleness and recovery', () => {
    it('session is not stale when heartbeat is within threshold', async () => {
      const sessions: StubHlsSession[] = [];
      const manager = makeSessionManager((channel, options) => {
        const s = new StubHlsSession(channel, options);
        sessions.push(s);
        return s;
      });

      await manager.getOrCreateHlsSession(channelUuid, '10.0.0.1', connection, {
        streamMode: 'hls',
      });
      const session = sessions[0]!;

      // Heartbeat was just recorded by getOrCreateHlsSession → addConnection
      expect(session.isStale()).toBe(false);

      // Advance to just inside the 60s default threshold
      vi.advanceTimersByTime(59_000);
      expect(session.isStale()).toBe(false);
    });

    it('session becomes stale when heartbeat exceeds threshold', async () => {
      const sessions: StubHlsSession[] = [];
      const manager = makeSessionManager((channel, options) => {
        const s = new StubHlsSession(channel, options);
        sessions.push(s);
        return s;
      });

      await manager.getOrCreateHlsSession(channelUuid, '10.0.0.1', connection, {
        streamMode: 'hls',
      });
      const session = sessions[0]!;

      // Advance past the 60s default threshold
      vi.advanceTimersByTime(61_000);
      expect(session.isStale()).toBe(true);
    });

    it('ghost heartbeat: recordHeartbeat after staleness removal does not prevent cleanup', async () => {
      const sessions: StubHlsSession[] = [];
      const manager = makeSessionManager((channel, options) => {
        const s = new StubHlsSession(channel, options);
        sessions.push(s);
        return s;
      });

      await manager.getOrCreateHlsSession(channelUuid, '10.0.0.1', connection, {
        streamMode: 'hls',
      });
      const session = sessions[0]!;

      // Advance past staleness threshold
      vi.advanceTimersByTime(61_000);

      // removeStaleConnections drops the connection
      expect(session.isStale()).toBe(true);
      // Connection is now gone from #connections
      expect(session.isKnownConnection('10.0.0.1')).toBe(false);

      // Client sends a segment request → recordHeartbeat is called
      // but this is a "ghost heartbeat" — it updates #heartbeats only
      session.recordHeartbeat('10.0.0.1');

      // Session is STILL stale because #connections is empty
      expect(session.isStale()).toBe(true);
    });

    it('addConnection after staleness removal restores the session', async () => {
      const sessions: StubHlsSession[] = [];
      const manager = makeSessionManager((channel, options) => {
        const s = new StubHlsSession(channel, options);
        sessions.push(s);
        return s;
      });

      await manager.getOrCreateHlsSession(channelUuid, '10.0.0.1', connection, {
        streamMode: 'hls',
      });
      const session = sessions[0]!;

      // Advance past staleness threshold
      vi.advanceTimersByTime(61_000);

      // Connection removed by staleness check
      expect(session.isStale()).toBe(true);
      expect(session.isKnownConnection('10.0.0.1')).toBe(false);

      // The fix: fragment route checks isKnownConnection and re-adds
      session.addConnection('10.0.0.1', { ip: '10.0.0.1' });
      session.recordHeartbeat('10.0.0.1');

      // Session is no longer stale
      expect(session.isStale()).toBe(false);
      expect(session.isKnownConnection('10.0.0.1')).toBe(true);
    });

    it('cleanupStaleSessions does not kill session with re-added connection', async () => {
      const sessions: StubHlsSession[] = [];
      const manager = makeSessionManager((channel, options) => {
        const s = new StubHlsSession(channel, options);
        sessions.push(s);
        return s;
      });

      await manager.getOrCreateHlsSession(channelUuid, '10.0.0.1', connection, {
        streamMode: 'hls',
      });
      const session = sessions[0]!;

      // Advance past staleness threshold
      vi.advanceTimersByTime(61_000);

      // First cleanup pass: marks as stale, removes connection
      manager.cleanupStaleSessions();

      // Simulate the fix: client requests a segment, connection is re-added
      session.addConnection('10.0.0.1', { ip: '10.0.0.1' });
      session.recordHeartbeat('10.0.0.1');

      // Grace period elapses (15s default)
      vi.advanceTimersByTime(16_000);

      // Session should still be in the manager — cleanup was aborted
      // because #connections is non-empty when the timer fires
      expect(manager.getHlsSession(channelUuid)).toBe(session);
    });
  });
  // The route behind GET /channels/:id/sessions reads this. Concat sessions are
  // keyed `${mode}_concat`, so a list that named three of them by hand reported
  // neither MPEG-TS nor the two newest modes.
  describe('getAllConcatSessions', () => {
    const putSession = (
      manager: SessionManager,
      sessionType: SessionConcatStreamMode,
    ) => {
      const session = { sessionType };
      (
        manager as unknown as {
          addSession: (id: string, t: string, s: unknown) => void;
        }
      ).addSession(channelUuid, sessionType, session);
      return session;
    };

    it('reports a concat session for every concat mode', () => {
      const manager = makeSessionManager(
        (channel, options) => new StubHlsSession(channel, options),
      );

      const sessions = SessionConcatStreamModes.map((mode) =>
        putSession(manager, mode),
      );

      expect(manager.getAllConcatSessions(channelUuid)).toEqual(
        expect.arrayContaining(sessions),
      );
      expect(manager.getAllConcatSessions(channelUuid)).toHaveLength(
        SessionConcatStreamModes.length,
      );
    });

    it('reports an etv_next_concat session', () => {
      const manager = makeSessionManager(
        (channel, options) => new StubHlsSession(channel, options),
      );

      const session = putSession(manager, 'etv_next_concat');

      expect(manager.getAllConcatSessions(channelUuid)).toEqual([session]);
    });

    it('ignores a non-concat session on the same channel', () => {
      const manager = makeSessionManager(
        (channel, options) => new StubHlsSession(channel, options),
      );

      (
        manager as unknown as {
          addSession: (id: string, t: string, s: unknown) => void;
        }
      ).addSession(channelUuid, 'etv_next', { sessionType: 'etv_next' });

      expect(manager.getAllConcatSessions(channelUuid)).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// TUNARR_MAX_SESSIONS / TUNARR_SESSION_SWEEP_INTERVAL_MS
// ---------------------------------------------------------------------------

describe('session cap and stale-session sweep', () => {
  const chA = '11111111-1111-1111-1111-111111111111';
  const chB = '22222222-2222-2222-2222-222222222222';
  const chC = '33333333-3333-3333-3333-333333333333';

  // One manager whose channel lookups return a channel per id, so each id
  // gets its own session.
  function makeMultiChannelManager(
    factory: (
      channel: ChannelOrmWithTranscodeConfig,
      options: HlsSessionOptions,
    ) => StubHlsSession = (channel, options) =>
      new StubHlsSession(channel, options),
  ) {
    const manager = makeSessionManager(factory);
    (manager as any).channelDB.getChannelOrm = vi.fn((id: string) =>
      Promise.resolve({
        uuid: id,
        number: 1,
        transcodeConfig: {},
      } as unknown as ChannelOrmWithTranscodeConfig),
    );
    return manager;
  }

  const tune = (
    manager: InstanceType<typeof SessionManager>,
    channelId: string,
    token: string,
  ) =>
    manager.getOrCreateHlsSession(channelId, token, connection, {
      streamMode: 'hls',
    });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('does not limit sessions when TUNARR_MAX_SESSIONS is unset', async () => {
    const manager = makeMultiChannelManager();
    for (const id of [chA, chB, chC]) {
      expect((await tune(manager, id, `viewer-${id}`)).isSuccess()).toBe(true);
    }
    expect(Object.keys(manager.allSessions())).toHaveLength(3);
  });

  it('allows sessions up to the cap', async () => {
    vi.stubEnv('TUNARR_MAX_SESSIONS', '2');
    const manager = makeMultiChannelManager();
    expect((await tune(manager, chA, 'a')).isSuccess()).toBe(true);
    expect((await tune(manager, chB, 'b')).isSuccess()).toBe(true);
    expect(Object.keys(manager.allSessions())).toHaveLength(2);
  });

  it('at the cap, ends the session idle the longest to start a new one', async () => {
    vi.stubEnv('TUNARR_MAX_SESSIONS', '2');
    vi.stubEnv('TUNARR_SESSION_EVICT_IDLE_MS', '10000');
    const manager = makeMultiChannelManager();

    const a = (await tune(manager, chA, 'a')).get();
    await vi.advanceTimersByTimeAsync(5_000);
    const b = (await tune(manager, chB, 'b')).get();
    // A's viewer flipped away 15s ago; B's is still watching.
    await vi.advanceTimersByTimeAsync(10_000);
    b.recordHeartbeat('b');

    const c = await tune(manager, chC, 'c');
    await vi.advanceTimersByTimeAsync(0);

    expect(c.isSuccess()).toBe(true);
    expect(manager.getHlsSession(chA)).toBeUndefined();
    expect(a.stoppingOrStopped).toBe(true);
    expect(manager.getHlsSession(chB)).toBe(b);
    expect(Object.keys(manager.allSessions())).toHaveLength(2);
  });

  it('refuses a new session when every session has a recent viewer', async () => {
    vi.stubEnv('TUNARR_MAX_SESSIONS', '2');
    vi.stubEnv('TUNARR_SESSION_EVICT_IDLE_MS', '10000');
    const manager = makeMultiChannelManager();

    const a = (await tune(manager, chA, 'a')).get();
    const b = (await tune(manager, chB, 'b')).get();
    await vi.advanceTimersByTimeAsync(5_000);

    const c = await tune(manager, chC, 'c');
    const { SessionCapacityError } = await import('@/types/errors.js');

    expect(c.isFailure()).toBe(true);
    expect(c.error).toBeInstanceOf(SessionCapacityError);
    expect(manager.getHlsSession(chA)).toBe(a);
    expect(manager.getHlsSession(chB)).toBe(b);
    expect(manager.getHlsSession(chC)).toBeUndefined();
  });

  it('a new viewer on a channel that already has a session does not count against the cap', async () => {
    vi.stubEnv('TUNARR_MAX_SESSIONS', '1');
    const manager = makeMultiChannelManager();

    const first = (await tune(manager, chA, 'a')).get();
    const second = await tune(manager, chA, 'second-viewer');

    expect(second.isSuccess()).toBe(true);
    expect(second.get()).toBe(first);
  });

  it('never ends a session that is still starting', async () => {
    vi.stubEnv('TUNARR_MAX_SESSIONS', '1');
    vi.stubEnv('TUNARR_SESSION_EVICT_IDLE_MS', '0');
    const manager = makeMultiChannelManager();

    const a = (await tune(manager, chA, 'a')).get();
    (a as any).state = 'starting';

    const b = await tune(manager, chB, 'b');

    expect(b.isFailure()).toBe(true);
    expect(manager.getHlsSession(chA)).toBe(a);
  });

  it('a sweep during startup does not end the session being started', async () => {
    vi.stubEnv('TUNARR_SESSION_STALENESS_MS', '20000');
    vi.stubEnv('TUNARR_SESSION_CLEANUP_DELAY_SECONDS', '1');

    // Like a real HLS session: 'started' at once, then a few seconds until
    // the first segments exist.
    class SlowReadySession extends StubHlsSession {
      protected override async waitForStreamReady() {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        const { Result } = await import('@/types/result.js');
        return Result.success(void 0);
      }
    }
    const manager = makeMultiChannelManager(
      (channel, options) => new SlowReadySession(channel, options),
    );
    manager.startStaleSessionSweep(500);

    const pending = tune(manager, chA, 'a');
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;

    expect(result.isSuccess()).toBe(true);
    const session = result.get();
    expect(session.stoppingOrStopped).toBe(false);
    expect(manager.getHlsSession(chA)).toBe(session);
  });

  it('with too little free GPU memory, ends an idle session to start a new one', async () => {
    vi.stubEnv('TUNARR_MIN_FREE_VRAM_MB', '700');
    vi.stubEnv('TUNARR_SESSION_EVICT_IDLE_MS', '10000');
    const manager = makeMultiChannelManager();
    // Something else takes the GPU while A runs: 600 MiB free; A's 3400 come back when it stops.
    let squeezed = false;
    const live = () =>
      Object.values(manager.allSessions()).filter((s) => !s.stoppingOrStopped).length;
    manager.probeResources = () =>
      Promise.resolve({ vramMb: squeezed && live() > 0 ? 600 : 4000, ramMb: 8000 });

    const a = (await tune(manager, chA, 'a')).get();
    await vi.advanceTimersByTimeAsync(15_000);
    squeezed = true;

    const b = await tune(manager, chB, 'b');
    await vi.advanceTimersByTimeAsync(0);

    expect(b.isSuccess()).toBe(true);
    expect(a.stoppingOrStopped).toBe(true);
    expect(manager.getHlsSession(chA)).toBeUndefined();
  });

  it('with too little free GPU memory and every session watched, refuses and says why', async () => {
    vi.stubEnv('TUNARR_MIN_FREE_VRAM_MB', '700');
    const manager = makeMultiChannelManager();
    manager.probeResources = () => Promise.resolve({ vramMb: 600, ramMb: 8000 });

    // Under the floor before anything runs: nothing to end, so refuse.
    const a = await tune(manager, chA, 'a');
    const { SessionCapacityError } = await import('@/types/errors.js');

    expect(a.isFailure()).toBe(true);
    expect(a.error).toBeInstanceOf(SessionCapacityError);
    expect(a.error.message).toContain('600 MiB GPU memory free');
  });

  it('holds back GPU memory for a session too new to have allocated', async () => {
    vi.stubEnv('TUNARR_MIN_FREE_VRAM_MB', '700');
    vi.stubEnv('TUNARR_STREAM_VRAM_ESTIMATE_MB', '500');
    const manager = makeMultiChannelManager();
    // The probe never sees A's memory: like two tune-ins a second apart.
    manager.probeResources = () => Promise.resolve({ vramMb: 1000 });

    const a = (await tune(manager, chA, 'a')).get();
    expect(a.state).toBe('started'); // HLS sessions leave 'starting' at once

    const b = await tune(manager, chB, 'b'); // 1000 free - 500 held for A < 700

    expect(b.isFailure()).toBe(true);
    expect(manager.getHlsSession(chA)).toBe(a);

    // Once A is past the allocation grace, the probe is trusted again.
    await vi.advanceTimersByTimeAsync(11_000);
    expect((await tune(manager, chB, 'b')).isSuccess()).toBe(true);
  });

  it('never ends a session too new to have its viewer registered', async () => {
    vi.stubEnv('TUNARR_MAX_SESSIONS', '1');
    vi.stubEnv('TUNARR_SESSION_EVICT_IDLE_MS', '0');
    const manager = makeMultiChannelManager();

    const a = (await tune(manager, chA, 'a')).get();
    a.removeConnection('a'); // as if its viewer weren't registered yet

    const b = await tune(manager, chB, 'b');

    expect(b.isFailure()).toBe(true);
    expect(manager.getHlsSession(chA)).toBe(a);
  });

  it('keeps ending idle sessions until the new one fits, waiting for each to stop', async () => {
    vi.stubEnv('TUNARR_MIN_FREE_VRAM_MB', '700');
    vi.stubEnv('TUNARR_SESSION_EVICT_IDLE_MS', '10000');
    const manager = makeMultiChannelManager();
    // 6000 MiB GPU, every live session holds 2000: 2000 free with both, 4000 with one.
    const live = () =>
      Object.values(manager.allSessions()).filter((s) => !s.stoppingOrStopped).length;
    manager.probeResources = () => Promise.resolve({ vramMb: 6000 - 2000 * live() });

    const a = (await tune(manager, chA, 'a')).get();
    await vi.advanceTimersByTimeAsync(11_000);
    const b = (await tune(manager, chB, 'b')).get();
    await vi.advanceTimersByTimeAsync(11_000); // both idle and past the grace
    // Now ask for more than one session's worth: only ending both makes room.
    vi.stubEnv('TUNARR_MIN_FREE_VRAM_MB', '4500');

    const pending = tune(manager, chC, 'c');
    await vi.advanceTimersByTimeAsync(0);
    const c = await pending;

    expect(c.isSuccess()).toBe(true);
    expect(a.stoppingOrStopped).toBe(true);
    expect(b.stoppingOrStopped).toBe(true);
    expect(Object.keys(manager.allSessions())).toHaveLength(1);
  });

  it('starts sessions while there is room, and skips a probe that failed', async () => {
    vi.stubEnv('TUNARR_MIN_FREE_VRAM_MB', '700');
    vi.stubEnv('TUNARR_MIN_AVAILABLE_RAM_MB', '1500');
    const manager = makeMultiChannelManager();
    manager.probeResources = () => Promise.resolve({ ramMb: 6000 }); // no nvidia-smi

    expect((await tune(manager, chA, 'a')).isSuccess()).toBe(true);
    expect((await tune(manager, chB, 'b')).isSuccess()).toBe(true);
  });

  it('the sweep cleans up an abandoned session without waiting for the cron', async () => {
    vi.stubEnv('TUNARR_SESSION_STALENESS_MS', '20000');
    vi.stubEnv('TUNARR_SESSION_CLEANUP_DELAY_SECONDS', '1');
    const manager = makeMultiChannelManager();
    manager.startStaleSessionSweep(5_000);

    const a = (await tune(manager, chA, 'a')).get();
    expect(manager.getHlsSession(chA)).toBe(a);

    // 20s staleness + up to one 5s sweep + 1s cleanup delay
    await vi.advanceTimersByTimeAsync(27_000);

    expect(manager.getHlsSession(chA)).toBeUndefined();
  });
});
