import { Result } from '@/types/result.js';
import type { Maybe } from '@/types/util.js';
import type { Logger } from '@/util/logging/LoggerFactory.js';
import { MutexMap } from '@/util/mutexMap.js';
import {
  compact,
  filter,
  initial,
  isEmpty,
  isNil,
  isUndefined,
  keys,
  max,
  maxBy,
  minBy,
  omitBy,
  values,
} from 'lodash-es';
import {
  ChannelNotFoundError,
  SessionCapacityError,
  TypedError,
} from '../types/errors.js';
import {
  type ConcatSessionFactory,
  type ConcatSessionOptions,
} from './ConcatSession.js';
import type {
  EtvNextSession,
  EtvNextSessionOptions,
  EtvNextSessionProvider,
} from './etv/EtvNextSession.js';
import { Session } from './Session.js';
import { probeFreeResources, type FreeResources } from './StreamResources.js';
import type { HlsSession, HlsSessionOptions } from './hls/HlsSession.js';
import {
  type HlsSessionProvider,
  type HlsSlowerSessionProvider,
} from './hls/HlsSession.js';
import type { HlsSlowerSession } from './hls/HlsSlowerSession.js';

import { type IChannelDB } from '@/db/interfaces/IChannelDB.js';
import type { ChannelOrmWithTranscodeConfig } from '@/db/schema/derivedTypes.js';
import { OnDemandChannelService } from '@/services/OnDemandChannelService.js';
import { KEYS } from '@/types/inject.js';
import { ifDefined } from '@/util/index.js';
import type { ChannelStreamMode } from '@tunarr/types';
import type { StreamConnectionDetails } from '@tunarr/types/api';
import type { SessionConcatStreamMode } from '@tunarr/types/schemas';
import { SessionConcatStreamModes } from '@tunarr/types/schemas';
import dayjs from 'dayjs';
import { inject, injectable } from 'inversify';
import type { Dictionary } from 'ts-essentials';
import type { ISettingsDB } from '../db/interfaces/ISettingsDB.ts';
import { EventService } from '../services/EventService.ts';
import { getNumericEnvVar, TUNARR_ENV_VARS } from '../util/env.ts';
import { InjectLogger } from '../util/inject.ts';
import type { SessionType } from './Session.js';
import type { BaseHlsSessionOptions } from './hls/BaseHlsSession.ts';

export type SessionKey = `${string}_${SessionType}`;

// Held while checking TUNARR_MAX_SESSIONS and registering a new session, so
// two channels starting at once can't both take the last slot.
const CapacityLockKey = '__session_capacity__';
const DefaultEvictIdleMs = 10_000;
// What a new stream will take once its ffmpeg allocates.
const DefaultStreamVramEstimateMb = 500;
const DefaultStreamRamEstimateMb = 300;
// How long to wait for an ended session's ffmpeg to exit (and free its
// memory) before checking for room again.
const EvictionStopWaitMs = 5_000;

const isConcatSessionType = (sessionType: string) =>
  (SessionConcatStreamModes as readonly string[]).includes(sessionType);

// Newest heartbeat across all of a session's viewers; 0 when it has none.
// Heartbeats are kept apart from the connection details, so read them by token.
const newestHeartbeat = (session: Session) =>
  max(
    keys(session.connections()).map(
      (token) => session.lastHeartbeat(token) ?? 0,
    ),
  ) ?? 0;

@injectable()
export class SessionManager {
  @InjectLogger() declare private readonly logger: Logger;

  #sessionLocker = new MutexMap();
  #sessions: Record<SessionKey, Session> = {};
  #sweepTimer?: NodeJS.Timeout;
  // Sessions whose start() has returned: their first segments exist, so their
  // ffmpeg has allocated its memory. Until then (HLS sessions report 'started'
  // before ffmpeg even spawns) a probe can't see a session's memory, so
  // admission holds back an estimate for it, and it can't be ended to make room.
  #ready = new WeakSet<Session>();
  /** Replaced in tests. */
  probeResources: () => Promise<FreeResources> = probeFreeResources;

  constructor(
    @inject(KEYS.ChannelDB) private channelDB: IChannelDB,
    @inject(OnDemandChannelService)
    private onDemandChannelService: OnDemandChannelService,
    @inject(KEYS.HlsSession) private hlsSessionFactory: HlsSessionProvider,
    @inject(KEYS.HlsSlowerSession)
    private hlsSlowerSessionFactory: HlsSlowerSessionProvider,
    @inject(KEYS.ConcatSession)
    private concatSessionFactory: ConcatSessionFactory,
    @inject(KEYS.EtvNextSession)
    private etvNextSessionFactory: EtvNextSessionProvider,
    @inject(EventService) private eventService: EventService,
    @inject(KEYS.SettingsDB) private settingsDB: ISettingsDB,
  ) {}

  allSessions(): Record<SessionKey, Session> {
    return this.#sessions;
  }

  allSessionsByChannel(): Record<
    string,
    Partial<Record<SessionType, Session>>
  > {
    const ret: Dictionary<Partial<Dictionary<Session, SessionType>>> = {};
    for (const [key, session] of Object.entries(this.#sessions)) {
      const [channelId, sessionType] = key.split('_', 2);
      if (!ret[channelId!]) {
        ret[channelId!] = {};
      }
      ret[channelId!]![sessionType!] = session;
    }
    return omitBy(ret, isEmpty);
  }

  getHlsSlowerSession(id: string): Maybe<HlsSlowerSession> {
    return this.getSession(id, 'hls_slower') as Maybe<HlsSlowerSession>;
  }

  getHlsSession(
    id: string,
    mode: 'hls' | 'hls_direct_v2' = 'hls',
  ): Maybe<HlsSession> {
    return this.getSession(id, mode) as Maybe<HlsSession>;
  }

  getEtvNextSession(id: string): Maybe<EtvNextSession> {
    return this.getSession(id, 'etv_next') as Maybe<EtvNextSession>;
  }

  /**
   * Every concat session a channel has open.
   *
   * Derived from `SessionConcatStreamModes` rather than listed, so a new concat
   * mode reports itself without a second edit here.
   */
  getAllConcatSessions(id: string): Session[] {
    return compact(
      SessionConcatStreamModes.map((mode) => this.getSession(id, mode)),
    );
  }

  getSession(id: string, sessionType: SessionType): Maybe<Session> {
    return this.#sessions[sessionCacheKey(id, sessionType)];
  }

  getAllSessionsForChannel(id: string): Session[] {
    const sessions: Session[] = [];
    for (const key of Object.keys(this.#sessions)) {
      if (key.startsWith(id)) {
        sessions.push(this.#sessions[key as SessionKey]!);
      }
    }
    return sessions;
  }

  async endSession(session: Session): Promise<void>;
  async endSession(
    idOrSession: string | Session,
    maybeSessionType?: SessionType,
  ): Promise<void> {
    let id: string;
    let sessionType: SessionType;
    if (idOrSession instanceof Session) {
      ({ id, sessionType } = idOrSession.keyObj);
    } else {
      if (isUndefined(maybeSessionType)) {
        throw new Error('Must pass session type if ending stream by ID');
      } else {
        id = idOrSession;
        sessionType = maybeSessionType;
      }
    }

    // Stop outside the channel lock. A stop can wait up to 30s for ffmpeg to
    // exit, and each session has its own directory, so a new tune-in on this
    // channel need not wait for it.
    const session = await this.removeSession(id, sessionType);
    await session?.stop();
  }

  /**
   * Like {@link endSession}, but resolves once the session is out of the map
   * and lets its stop (which can wait up to 30s for ffmpeg) finish in the
   * background.
   */
  async endSessionInBackground(session: Session): Promise<void> {
    const { id, sessionType } = session.keyObj;
    const removed = await this.removeSession(id, sessionType);
    removed?.stop().catch((e) => {
      this.logger.error(
        this.getLoggerContext(id, e),
        'Error shutting down session',
      );
    });
  }

  private async removeSession(
    id: string,
    sessionType: SessionType,
  ): Promise<Maybe<Session>> {
    const lock = await this.#sessionLocker.getOrCreateLock(id);
    return lock.runExclusive(() => {
      const session = this.getSession(id, sessionType);
      delete this.#sessions[sessionCacheKey(id, sessionType)];
      return session;
    });
  }

  /**
   * Run {@link cleanupStaleSessions} every `intervalMs`, so a session whose
   * viewers left is cleaned up within seconds instead of on the next
   * one-minute cron run.
   */
  startStaleSessionSweep(intervalMs: number) {
    clearInterval(this.#sweepTimer);
    this.#sweepTimer = setInterval(() => this.cleanupStaleSessions(), intervalMs);
    this.#sweepTimer.unref();
  }

  cleanupStaleSessions() {
    for (const session of Object.values(this.#sessions)) {
      if (session.state === 'starting') {
        continue;
      }
      if (session.isStale() && session.scheduleCleanup()) {
        this.logger.debug(
          this.getLoggerContext(session.id),
          'Scheduled cleanup on session',
        );
      }
    }
  }

  async getOrCreateConcatSession(
    channelId: string,
    token: string,
    connection: StreamConnectionDetails,
    options: ConcatSessionOptions,
  ) {
    const lock = await this.#sessionLocker.getOrCreateLock(channelId);
    await lock.runExclusive(() => {
      const underlyingSessionType = sessionTypeFromConcatType(
        options.sessionType,
      );
      const underlying = this.getSession(channelId, underlyingSessionType);
      if (isUndefined(underlying) || underlying.stoppingOrStopped) {
        this.logger.debug(
          'No underlying session of type %s found for existing concat session (channel id = %s). Removing dangling session and recreating',
          underlyingSessionType,
          channelId,
        );
        this.deleteSession(channelId, underlyingSessionType);
      }
    });

    return this.getOrCreateSession(
      channelId,
      token,
      connection,
      options.sessionType,
      (channel) => {
        options.cleanupDelayMs ??= 5_000;
        return this.concatSessionFactory(channel, options);
      },
    );
  }

  // TODO Consider using a builder pattern here with generics to control
  // the returned session type
  /**
   * Gets or starts the `ersatztv-channel` worker session for a channel.
   *
   * Staleness deliberately does not read SESSION_STALENESS_MS the way the HLS
   * factories do. The worker reaps itself on a stale heartbeat file at 90s, so
   * a larger value set for the other backends would let the file clock end
   * sessions first. An explicit option still wins.
   */
  async getOrCreateEtvNextSession(
    channelId: string,
    token: string,
    connection: StreamConnectionDetails,
    options?: Partial<EtvNextSessionOptions>,
  ) {
    return this.getOrCreateSession(
      channelId,
      token,
      connection,
      'etv_next',
      (channel) =>
        this.etvNextSessionFactory(channel, {
          transcodeDirectory:
            this.settingsDB.ffmpegSettings().transcodeDirectory,
          ...options,
        }),
    );
  }

  async getOrCreateHlsSlowerSession(
    channelId: string,
    token: string,
    connection: StreamConnectionDetails,
    options?: Partial<BaseHlsSessionOptions>,
  ) {
    return this.getOrCreateSession(
      channelId,
      token,
      connection,
      'hls_slower',
      (channel) =>
        this.hlsSlowerSessionFactory(channel, {
          initialSegmentCount: 2, // 8 seconds of content
          transcodeDirectory:
            this.settingsDB.ffmpegSettings().transcodeDirectory,
          stalenessMs:
            getNumericEnvVar(TUNARR_ENV_VARS.SESSION_STALENESS_MS) ?? undefined,
          ...options,
        }),
    );
  }

  async getOrCreateHlsSession(
    channelId: string,
    token: string,
    connection: StreamConnectionDetails,
    options?: Partial<HlsSessionOptions>,
  ) {
    return this.getOrCreateSession(
      channelId,
      token,
      connection,
      options?.streamMode ?? 'hls',
      (channel) =>
        this.hlsSessionFactory(channel, {
          initialSegmentCount: 2, // 8 seconds of content
          transcodeDirectory:
            this.settingsDB.ffmpegSettings().transcodeDirectory,
          streamMode: options?.streamMode ?? 'hls',
          stalenessMs:
            getNumericEnvVar(TUNARR_ENV_VARS.SESSION_STALENESS_MS) ?? undefined,
          ...options,
        }),
    );
  }

  private async getOrCreateSession<TSession extends Session>(
    channelId: string,
    token: string,
    connection: StreamConnectionDetails,
    sessionType: SessionType,
    sessionFactory: (channel: ChannelOrmWithTranscodeConfig) => TSession,
  ): Promise<Result<TSession, TypedError>> {
    const lock = await this.#sessionLocker.getOrCreateLock(channelId);
    try {
      const session = await lock.runExclusive(async () => {
        let session = this.getSession(
          channelId,
          sessionType,
        ) as Maybe<TSession>;

        // A stopping session keeps its own working directory until its
        // process exits, so a replacement can start alongside it.
        if (isNil(session) || session.stoppingOrStopped) {
          const channel = await this.channelDB.getChannelOrm(channelId);

          if (!channel?.transcodeConfig) {
            throw new ChannelNotFoundError(channelId);
          }

          const capacityLock =
            await this.#sessionLocker.getOrCreateLock(CapacityLockKey);
          session = await capacityLock.runExclusive(async () => {
            await this.reclaimCapacity(channelId, sessionType);
            const created = sessionFactory(channel);
            this.addSession(channel.uuid, created.sessionType, created);
            // Registered before the lock is released, so the next admission
            // never sees this session with no viewer.
            created.addConnection(token, connection);
            return created;
          });

          session.on('error', (e) => {
            this.logger.error(
              this.getLoggerContext(session?.id, e),
              'Received error from session. Shutting down',
            );
            session?.stop().catch((e) => {
              this.logger.error(
                this.getLoggerContext(session?.id, e),
                'Error while shutting down session. Things are bad!',
              );
            });
            if (this.getSession(channelId, sessionType) === session) {
              this.shutdownChildSessions(channelId, sessionType);
            }
            this.eventService.push({
              type: 'stream',
              action: 'error',
              level: 'error',
              details: {
                channelId,
                sessionType,
              },
            });
          });

          session.on('stop', () => {
            if (this.getSession(channelId, sessionType) === session) {
              this.deleteSession(channelId, sessionType);
              this.shutdownChildSessions(channelId, sessionType);
            }
            if (session) {
              this.pauseChannelIfNecessary(session, connection).catch(() => {});
            }
            this.eventService.push({
              type: 'stream',
              action: 'end',
              level: 'info',
              details: {
                channelId,
                sessionType,
              },
            });
          });

          session.on('cleanup', () => {
            // Verify the session in the map is the same instance. A delayed
            // cleanup timer from a previous session must not delete a
            // replacement session that was created at the same key.
            if (this.getSession(channelId, sessionType) === session) {
              this.deleteSession(channelId, sessionType);
              this.shutdownChildSessions(channelId, sessionType);
            }
          });

          session.on('removeConnection', (_, connection) => {
            this.logger.debug(
              this.getLoggerContext(session?.id),
              'Connection removed for session %s: %O',
              session?.id ?? '',
              connection,
            );
            // Error handled below
            if (session) {
              this.pauseChannelIfNecessary(session, connection).catch(() => {});
            }
            this.eventService.push({
              type: 'stream',
              action: 'connection_remove',
              level: 'info',
              details: {
                channelId,
                sessionType,
              },
            });
          });

          if (this.getAllSessionsForChannel(channelId).length > 0) {
            this.resumeChannelIfNecessary(channelId);
          }
        }

        // Register the viewer before starting, under the lock. HLS sessions are
        // 'started' while they wait for their first segments; with no
        // connection yet, a stale sweep in that window would end them.
        session.addConnection(token, connection);

        if (!session.started || session.hasError) {
          await session.start();
          if (session.error === undefined) {
            this.#ready.add(session);
          }
          this.eventService.push({
            type: 'stream',
            action: 'start',
            level: 'info',
            details: {
              channelId,
              sessionType,
            },
          });
        }

        return session;
      });

      // Read the error rather than the state. The 'error' handler above stops
      // a failed session, which moves it to 'stopped' before this check runs.
      if (session.error !== undefined) {
        throw session.error;
      }

      this.eventService.push({
        type: 'stream',
        action: 'connection_add',
        level: 'info',
        details: {
          channelId,
          sessionType,
        },
      });

      return Result.success(session);
    } catch (e) {
      return Result.failure(TypedError.fromAny(e));
    }
  }

  /**
   * Make room before a new session starts. There is no room when
   * TUNARR_MAX_SESSIONS sessions are running, or when free GPU memory or
   * available RAM is below TUNARR_MIN_FREE_VRAM_MB / TUNARR_MIN_AVAILABLE_RAM_MB
   * (counting what streams that are still starting will take). Then end the
   * session whose newest viewer heartbeat is oldest, provided it has been idle
   * for at least TUNARR_SESSION_EVICT_IDLE_MS; if every session has a recent
   * viewer, refuse the new one.
   */
  private async reclaimCapacity(channelId: string, sessionType: SessionType) {
    if (isConcatSessionType(sessionType)) {
      return;
    }
    const idleMs =
      getNumericEnvVar(TUNARR_ENV_VARS.SESSION_EVICT_IDLE_MS) ??
      DefaultEvictIdleMs;

    // Each ended session frees a slot at once but its memory only when its
    // ffmpeg exits, and one may not be enough: end one, wait, check again.
    // A session whose stop outlasts the wait is still counted, never re-picked.
    const ended = new Set<Session>();
    for (;;) {
      const active = filter(
        values(this.#sessions),
        (s) => !s.stoppingOrStopped && !isConcatSessionType(s.sessionType),
      );
      const shortfall = await this.capacityShortfall(active);
      if (!shortfall) {
        return;
      }

      const now = dayjs().valueOf();
      const victim = minBy(
        filter(
          active.map((session) => ({ session, lastSeen: newestHeartbeat(session) })),
          ({ session, lastSeen }) =>
            !ended.has(session) &&
            session.state !== 'starting' &&
            now - lastSeen >= idleMs &&
            this.#ready.has(session),
        ),
        'lastSeen',
      );

      if (!victim) {
        this.logger.warn(
          'No room (%s) and every session has a viewer; refusing %s on channel %s',
          shortfall,
          sessionType,
          channelId,
        );
        throw new SessionCapacityError(shortfall);
      }

      this.logger.info(
        this.getLoggerContext(victim.session.id),
        'No room (%s): ending a session idle for %dms to start %s on channel %s',
        shortfall,
        now - victim.lastSeen,
        sessionType,
        channelId,
      );
      // Wait (bounded) for its ffmpeg to exit so the next probe sees the
      // memory it freed.
      ended.add(victim.session);
      await Promise.race([
        this.endSession(victim.session).catch((e) =>
          this.logger.error(
            this.getLoggerContext(victim.session.id, e),
            'Error ending session to make room',
          ),
        ),
        new Promise((resolve) => setTimeout(resolve, EvictionStopWaitMs)),
      ]);
    }
  }

  /** Why another stream doesn't fit right now, or undefined if it does. */
  private async capacityShortfall(active: Session[]): Promise<string | undefined> {
    const maxSessions = getNumericEnvVar(TUNARR_ENV_VARS.MAX_SESSIONS) ?? 0;
    if (maxSessions > 0 && active.length >= maxSessions) {
      return `${active.length} of ${maxSessions} sessions running`;
    }

    const minVram = getNumericEnvVar(TUNARR_ENV_VARS.MIN_FREE_VRAM_MB) ?? 0;
    const minRam = getNumericEnvVar(TUNARR_ENV_VARS.MIN_AVAILABLE_RAM_MB) ?? 0;
    if (minVram <= 0 && minRam <= 0) {
      return;
    }

    // Sessions still starting haven't allocated yet (see #ready); hold back
    // what they will take.
    const starting = active.filter((s) => !this.#ready.has(s)).length;
    const free = await this.probeResources();
    if (minVram > 0 && free.vramMb === undefined) {
      this.logger.warn('Free GPU memory probe failed (nvidia-smi); admitting without the VRAM check');
    }
    if (minRam > 0 && free.ramMb === undefined) {
      this.logger.warn('Available RAM probe failed (/proc/meminfo); admitting without the RAM check');
    }
    const vramNeed =
      minVram +
      starting *
        (getNumericEnvVar(TUNARR_ENV_VARS.STREAM_VRAM_ESTIMATE_MB) ??
          DefaultStreamVramEstimateMb);
    if (minVram > 0 && free.vramMb !== undefined && free.vramMb < vramNeed) {
      return `${free.vramMb} MiB GPU memory free, need ${vramNeed}`;
    }
    const ramNeed =
      minRam +
      starting *
        (getNumericEnvVar(TUNARR_ENV_VARS.STREAM_RAM_ESTIMATE_MB) ??
          DefaultStreamRamEstimateMb);
    if (minRam > 0 && free.ramMb !== undefined && free.ramMb < ramNeed) {
      return `${free.ramMb} MiB RAM available, need ${ramNeed}`;
    }
    return;
  }

  private addSession(id: string, sessionType: SessionType, session: Session) {
    this.#sessions[sessionCacheKey(id, sessionType)] = session;
  }

  private deleteSession(id: string, sessionType: SessionType) {
    const key = sessionCacheKey(id, sessionType);
    ifDefined(this.#sessions[key], (session) => {
      session.stop().catch((e) => {
        this.logger.error(
          this.getLoggerContext(id, e),
          'Error shutting down session',
        );
      });
    });
    delete this.#sessions[key];
  }

  private resumeChannelIfNecessary(channelId: string) {
    this.logger.debug('Resuming channel %s at %s', channelId, dayjs().format());
    this.onDemandChannelService.resumeChannel(channelId).catch((e) => {
      this.logger.error(
        this.getLoggerContext(channelId, e),
        'Error resuming on-demand channel %s',
        channelId,
      );
    });
  }

  private async pauseChannelIfNecessary(
    session: Session,
    lastConnection: StreamConnectionDetails,
  ) {
    try {
      const now = +dayjs();
      let sessionToCheck = session;
      let pauseTime = lastConnection.lastHeartbeat ?? now;
      if (session.isConcatSession()) {
        const underlyingType = sessionTypeFromConcatType(session.sessionType);
        const underlyingSession = this.getSession(
          session.keyObj.id,
          underlyingType,
        );
        if (underlyingSession) {
          sessionToCheck = underlyingSession;
          pauseTime =
            maxBy(values(sessionToCheck.connections()), 'lastHeartbeat')
              ?.lastHeartbeat ?? +dayjs();
        }
      }

      if (
        sessionToCheck.sessionType === 'mpegts_concat' ||
        sessionToCheck.sessionType === 'mpegts'
      ) {
        // No heartbeats on a raw stream, just pause at "now"
        pauseTime = now;
      }

      const nonTunarrConnections = filter(
        sessionToCheck.connections(),
        (conn) => !(conn.userAgent?.includes('Tunarr') ?? false),
      ).length;

      // Pause the channel as soon as there are no connections
      // other than internal connections
      if (nonTunarrConnections === 0) {
        this.logger.debug(
          this.getLoggerContext(session.id),
          'Pausing channel %s after disconnect. Pause time = %s',
          session.keyObj.id,
          dayjs(pauseTime).format(),
        );
        await this.onDemandChannelService.pauseChannel(
          session.keyObj.id,
          pauseTime,
        );
      } else {
        this.logger.debug(
          this.getLoggerContext(sessionToCheck.id),
          'Detected %d remaining sessions. Not pausing session.',
          nonTunarrConnections,
        );
      }
    } catch (e) {
      this.logger.error(
        this.getLoggerContext(session.id, e),
        'Error while trying to pause channel %s',
        session.id,
      );
    }
  }

  private shutdownChildSessions(id: string, sessionType: SessionType) {
    this.getSession(id, concatSessionTypeForSessionType(sessionType))
      ?.stop()
      .catch((e) => {
        this.logger.error(e, 'Error shutting down associated concat session');
      });
  }

  private getLoggerContext(sessionId?: string, error?: unknown) {
    return { error, sessionId };
  }
}

function sessionTypeFromConcatType(
  typ: SessionConcatStreamMode,
): ChannelStreamMode {
  return initial(typ.split('_')).join('_') as ChannelStreamMode;
}

function concatSessionTypeForSessionType(
  typ: SessionType,
): SessionConcatStreamMode {
  return `${typ}_concat` as SessionConcatStreamMode;
}

function sessionCacheKey(id: string, sessionType: SessionType): SessionKey {
  return `${id}_${sessionType}`;
}
