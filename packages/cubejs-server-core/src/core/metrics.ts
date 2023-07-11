import { v4 as uuidv4 } from 'uuid';
import { register, collectDefaultMetrics, Gauge } from 'prom-client'

class Metrics {
  compilerApi: any;
  orchestratorApi: any;
  refreshScheduler: any;
  scheduledRefreshTimeZones: any;
  metricsContext: any;
  logger: any;

  constructor({ compilerApi, orchestratorApi, refreshScheduler, scheduledRefreshTimeZones, metricsContext, logger }) {
    this.compilerApi = compilerApi;
    this.orchestratorApi = orchestratorApi;
    this.refreshScheduler = refreshScheduler;
    this.scheduledRefreshTimeZones = scheduledRefreshTimeZones;
    this.metricsContext = metricsContext;
    this.logger = logger;

    collectDefaultMetrics();
    const metrics = this;

    this.getPartitionsStatus().then(() => {
      // Only register gauge after one succesfull call since it may take a longish time to return
      new Gauge({
        name: 'cube_pending_pre_agg_partitions',
        help: 'number of pre aggregation partitions that are not built yet',

        async collect() {
            const partitionStatus = await metrics.getPartitionsStatus()
            const totalMissingPartitions = partitionStatus.filter(status => !status.isPresent).length
            this.set(totalMissingPartitions)
        }
      })
    })
  }

  public getMetrics(): Promise<string> {
    return register.metrics();
  }

  private async getPartitionsStatus(): Promise<any[]> {
    const context = { ...this.metricsContext, requestId: `${uuidv4()}-span-1` }
    const preAggregations = await this.compilerApi(context).preAggregations();

    let finalStatus: any[] = []
    for (;;) {
      try {
        const preAggregationPartitions = await this.refreshScheduler
          .preAggregationPartitions(
            context,
            {
              metadata: {},
              timezones: ['UTC'],
              preAggregations: preAggregations.map(p => ({
                id: p.id,
                cacheOnly: false,
              }))
            },
          );
        const preAggregationPartitionsWithoutError = preAggregationPartitions.filter(p => !p?.errors?.length);

        const versionEntriesResult: any = preAggregationPartitions &&
          await this.orchestratorApi(context).getPreAggregationVersionEntries(
            context,
            preAggregationPartitionsWithoutError,
            this.compilerApi(this.metricsContext).preAggregationsSchema
          );

        const delcaredPartitions = versionEntriesResult.structureVersionsByTableName
        const existingPartitions = versionEntriesResult.versionEntriesByTableName

        for (const [tableName, structuredVersion] of Object.entries(delcaredPartitions)) {
          const versions = existingPartitions[tableName] ?? []
          const isPresent = versions.map(v => v.structure_version).includes(structuredVersion)

          finalStatus.push(
            {
              table: tableName,
              isPresent: isPresent
            }
          )
        }
      } catch (e: any) {
        if (e.error == 'Continue wait') {
          // Everything is fine, just have to query stuff again
        } else {
          console.log(e)
          throw e
        }
      }

      break
    }

    return finalStatus
  }
}

export { Metrics };
