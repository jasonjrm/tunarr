import { inject, injectable } from 'inversify';
import { filter, flatten, forEach, values } from 'lodash-es';
import { container } from '../../container.ts';
import type { ISettingsDB } from '../../db/interfaces/ISettingsDB.ts';
import { CleanupSessionsTask } from '../../tasks/CleanupSessionsTask.ts';
import { OnDemandChannelStateTask } from '../../tasks/OnDemandChannelStateTask.ts';
import { RefreshMediaSourceLibraryTask } from '../../tasks/RefreshMediaSourceLibraryTask.ts';
import { ScanLibrariesTask } from '../../tasks/ScanLibrariesTask.ts';
import { ScheduledTask } from '../../tasks/ScheduledTask.ts';
import { SubtitleExtractorTask } from '../../tasks/SubtitleExtractorTask.ts';
import { SyncCollectionsTask } from '../../tasks/SyncCollectionsTask.ts';
import { SyncCustomShowsTask } from '../../tasks/SyncCustomShowsTask.ts';
import { UpdateXmlTvTask } from '../../tasks/UpdateXmlTvTask.ts';
import { SessionManager } from '../../stream/SessionManager.ts';
import { getEnvVar, getNumericEnvVar, TUNARR_ENV_VARS } from '../../util/env.ts';
import { LiveConfig } from '../../util/liveConfig.ts';
import { autoFactoryKey, KEYS } from '../../types/inject.ts';
import { InjectLogger } from '../../util/inject.ts';
import type { Logger } from '../../util/logging/LoggerFactory.ts';
import { LoggerFactory } from '../../util/logging/LoggerFactory.ts';
import {
  GlobalScheduler,
  hoursCrontab,
  minutesCrontab,
  scheduleBackupJobs,
} from '../Scheduler.ts';
import { ChannelLineupMigratorStartupTask } from './ChannelLineupMigratorStartupTask.ts';
import { SimpleStartupTask } from './IStartupTask.ts';

@injectable()
export class ScheduleJobsStartupTask extends SimpleStartupTask {
  id = ScheduleJobsStartupTask.name;
  dependencies = [ChannelLineupMigratorStartupTask.name];

  @InjectLogger() declare private readonly logger: Logger;

  constructor(@inject(KEYS.SettingsDB) private settingsDB: ISettingsDB) {
    super();
  }

  getPromise(): Promise<void> {
    const xmlTvSettings = this.settingsDB.xmlTvSettings();

    GlobalScheduler.scheduleTask(
      UpdateXmlTvTask.ID,
      new ScheduledTask(
        UpdateXmlTvTask,
        hoursCrontab(xmlTvSettings.refreshHours),
        container.get<() => UpdateXmlTvTask>(KEYS.UpdateXmlTvTaskFactory),
        {},
      ),
    );

    GlobalScheduler.scheduleTask(
      CleanupSessionsTask.ID,
      new ScheduledTask(
        CleanupSessionsTask,
        minutesCrontab(1),
        container.get<() => CleanupSessionsTask>(CleanupSessionsTask.KEY),
        undefined,
      ),
    );

    const sessionManager = container.get(SessionManager);
    let sweepMs = getNumericEnvVar(TUNARR_ENV_VARS.SESSION_SWEEP_INTERVAL_MS);
    const applySweep = () => {
      if (sweepMs && sweepMs > 0) {
        sessionManager.startStaleSessionSweep(sweepMs);
      } else {
        sessionManager.stopStaleSessionSweep();
      }
    };

    // Stream limits from a KEY=value file, re-read when it changes, so the cap
    // and timings can be tuned without a restart.
    const configPath = getEnvVar(TUNARR_ENV_VARS.TUNAAR_CONFIG);
    if (configPath) {
      const liveConfig = new LiveConfig(configPath);
      const reload = () => {
        const result = liveConfig.reloadIfChanged();
        if (!result) {
          return;
        }
        for (const problem of result.problems) {
          this.logger.warn('%s: %s', configPath, problem);
        }
        if (Object.keys(result.changed).length > 0) {
          this.logger.info('%s: applied %j', configPath, result.changed);
        }
        const nextSweep = getNumericEnvVar(TUNARR_ENV_VARS.SESSION_SWEEP_INTERVAL_MS);
        if (nextSweep !== sweepMs) {
          sweepMs = nextSweep;
          applySweep();
        }
      };
      reload();
      setInterval(reload, 5_000).unref();
    }
    applySweep();

    GlobalScheduler.scheduleTask(
      OnDemandChannelStateTask.ID,
      new ScheduledTask(
        OnDemandChannelStateTask,
        minutesCrontab(1),
        container.get<() => OnDemandChannelStateTask>(
          OnDemandChannelStateTask.KEY,
        ),
        undefined,
        { runAtStartup: true },
      ),
    );

    GlobalScheduler.scheduleTask(
      SubtitleExtractorTask.ID,
      new ScheduledTask(
        SubtitleExtractorTask,
        hoursCrontab(1),
        container.get<() => SubtitleExtractorTask>(
          autoFactoryKey(SubtitleExtractorTask),
        ),
        {},
        {
          runAtStartup: true,
        },
      ),
    );

    GlobalScheduler.scheduleTask(
      RefreshMediaSourceLibraryTask.ID,
      new ScheduledTask(
        RefreshMediaSourceLibraryTask,
        hoursCrontab(1),
        () =>
          container.get<RefreshMediaSourceLibraryTask>(
            RefreshMediaSourceLibraryTask,
          ),
        undefined,
      ),
    );

    GlobalScheduler.scheduleTask(
      ScanLibrariesTask.ID,
      new ScheduledTask(
        ScanLibrariesTask,
        // Offset from the hourly library refresh so scans never start while
        // library availability is being updated.
        hoursCrontab(
          this.settingsDB.globalMediaSourceSettings().rescanIntervalHours,
          30,
        ),
        container.get<() => ScanLibrariesTask>(ScanLibrariesTask.KEY),
        undefined,
      ),
    );

    GlobalScheduler.scheduleTask(
      SyncCollectionsTask.ID,
      new ScheduledTask(
        SyncCollectionsTask,
        hoursCrontab(
          this.settingsDB.globalMediaSourceSettings().rescanIntervalHours,
        ),
        container.get<() => SyncCollectionsTask>(SyncCollectionsTask.KEY),
        undefined,
      ),
    );

    GlobalScheduler.scheduleTask(
      SyncCustomShowsTask.ID,
      new ScheduledTask(
        SyncCustomShowsTask,
        hoursCrontab(
          this.settingsDB.globalMediaSourceSettings().rescanIntervalHours,
        ),
        container.get<() => SyncCustomShowsTask>(SyncCustomShowsTask.KEY),
        undefined,
      ),
    );

    scheduleBackupJobs(this.settingsDB.backup);

    forEach(
      filter(
        flatten(values(GlobalScheduler.scheduledJobsById)),
        (job) => job.runAtStartup,
      ),
      (job) => {
        this.logger.debug('Running startup task %s', job.name);
        job
          .runNow(true)
          .catch((e) =>
            LoggerFactory.root.error(
              e,
              'Error running job %s at startup',
              job.name,
            ),
          );
      },
    );

    return Promise.resolve();
  }
}
