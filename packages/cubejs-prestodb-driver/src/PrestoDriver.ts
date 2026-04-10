/**
 * @copyright Cube Dev, Inc.
 * @license Apache-2.0
 * @fileoverview The `PrestoDriver` and related types declaration.
 */

import {
  DownloadQueryResultsOptions, DownloadQueryResultsResult,
  DriverCapabilities, DriverInterface,
  StreamOptions,
  StreamTableData,
  TableStructure,
  BaseDriver,
  UnloadOptions,
  TableCSVData,
} from '@cubejs-backend/base-driver';
import {
  getEnv,
  assertDataSource,
} from '@cubejs-backend/shared';

import { Transform, TransformCallback } from 'stream';
import type { ConnectionOptions as TLSConnectionOptions } from 'tls';

import {
  map, zipObj, prop, concat
} from 'ramda';
import SqlString from 'sqlstring';
import { S3, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const presto = require('presto-client');

export type PrestoDriverExportBucket = {
  exportBucket?: string,
  bucketType?: 'gcs' | 's3',
  credentials?: any,
  accessKeyId?: string,
  secretAccessKey?: string,
  exportBucketRegion?: string,
  exportBucketS3AdvancedFS?: boolean,
  exportBucketCsvEscapeSymbol?: string,
};

export type PrestoDriverConfiguration = PrestoDriverExportBucket & {
  host?: string;
  port?: string;
  catalog?: string;
  schema?: string;
  user?: string;
  // eslint-disable-next-line camelcase
  custom_auth?: string;
  // eslint-disable-next-line camelcase
  basic_auth?: { user: string, password: string };
  ssl?: string | TLSConnectionOptions;
  dataSource?: string;
  queryTimeout?: number;
  unloadCatalog?: string;
  unloadSchema?: string;
  unloadBucket?: string;
  unloadPrefix?: string;
  region?: string;
  s3Client?: S3
};

const SUPPORTED_BUCKET_TYPES = ['gcs', 's3'];
/**
 * Presto driver class.
 */
export class PrestoDriver extends BaseDriver implements DriverInterface {
  /**
   * Returns default concurrency value.
   */
  public static getDefaultConcurrency() {
    return 2;
  }

  protected readonly config: PrestoDriverConfiguration;

  protected readonly catalog: string | undefined;

  protected client: any;

  protected useSelectTestConnection: boolean;

  /**
   * Class constructor.
   */
  public constructor(config: PrestoDriverConfiguration = {}) {
    super();

    const dataSource =
      config.dataSource ||
      assertDataSource('default');

    const dbUser = getEnv('dbUser', { dataSource });
    const dbPassword = getEnv('dbPass', { dataSource });
    const authToken = getEnv('prestoAuthToken', { dataSource });

    if (authToken && dbPassword) {
      throw new Error('Both user/password and auth token are set. Please remove password or token.');
    }

    this.useSelectTestConnection = getEnv('dbUseSelectTestConnection', { dataSource });

    this.config = {
      host: getEnv('dbHost', { dataSource }),
      port: getEnv('dbPort', { dataSource }),
      catalog:
        getEnv('prestoCatalog', { dataSource }) ||
        getEnv('dbCatalog', { dataSource }),
      schema:
        getEnv('dbName', { dataSource }) ||
        getEnv('dbSchema', { dataSource }),
      user: dbUser,
      ...(authToken ? { custom_auth: `Bearer ${authToken}` } : {}),
      ...(dbPassword ? { basic_auth: { user: dbUser, password: dbPassword } } : {}),
      ssl: this.getSslOptions(dataSource),
      bucketType: getEnv('dbExportBucketType', { supported: SUPPORTED_BUCKET_TYPES, dataSource }),
      exportBucket: getEnv('dbExportBucket', { dataSource }),
      accessKeyId: getEnv('dbExportBucketAwsKey', { dataSource }),
      secretAccessKey: getEnv('dbExportBucketAwsSecret', { dataSource }),
      exportBucketRegion: getEnv('dbExportBucketAwsRegion', { dataSource }),
      credentials: getEnv('dbExportGCSCredentials', { dataSource }),
      queryTimeout: getEnv('dbQueryTimeout', { dataSource }),
      region: config.region || getEnv('prestoAwsRegion', { dataSource }),
      unloadBucket: config.unloadBucket || getEnv('prestoUnloadBucket', { dataSource }),
      unloadPrefix: config.unloadPrefix || getEnv('prestoUnloadPrefix', { dataSource }),
      unloadCatalog: config.unloadCatalog || getEnv('prestoUnloadCatalog', { dataSource }),
      unloadSchema: config.unloadSchema || getEnv('prestoUnloadSchema', { dataSource }),
      ...config
    };
    this.catalog = this.config.catalog;
    this.client = new presto.Client({
      timeout: this.config.queryTimeout,
      ...this.config,
    });
  }

  public async testConnection(): Promise<void> {
    if (this.useSelectTestConnection) {
      return this.testConnectionViaSelect();
    }

    return new Promise((resolve, reject) => {
      // Get node list of presto cluster and return it.
      // @see https://prestodb.io/docs/current/rest/node.html
      this.client.nodes(null, (error: any, _result: any[]) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  protected async testConnectionViaSelect() {
    const query = SqlString.format('SELECT 1', []);
    await this.queryPromised(query, false);
  }

  public query(query: string, values: unknown[]): Promise<any[]> {
    return <Promise<any[]>> this.queryPromised(this.prepareQueryWithParams(query, values), false);
  }

  public prepareQueryWithParams(query: string, values: unknown[]) {
    return SqlString.format(query, (values || []).map(value => (typeof value === 'string' ? {
      toSqlString: () => SqlString.escape(value).replace(/\\\\([_%])/g, '\\$1'),
    } : value)));
  }

  public queryPromised(query: string, streaming: boolean): Promise<any[] | StreamTableData> {
    const toError = (error: any) => new Error(error.error ? `${error.message}\n${error.error}` : error.message);
    if (streaming) {
      const rowStream = new Transform({
        writableObjectMode: true,
        readableObjectMode: true,

        transform(obj: any, encoding: string, callback: TransformCallback) {
          callback(null, obj);
        }
      });

      return new Promise((resolve, reject) => {
        this.client.execute({
          query,
          schema: this.config.schema || 'default',
          session: this.config.queryTimeout ? `query_max_run_time=${this.config.queryTimeout}s` : undefined,
          columns: (error: any, columns: TableStructure) => {
            resolve({
              rowStream,
              types: columns
            });
          },
          data: (error: any, data: any[], columns: TableStructure) => {
            const normalData = this.normalizeResultOverColumns(data, columns);
            for (const obj of normalData) {
              rowStream.write(obj);
            }
          },
          success: () => {
            rowStream.end();
          },
          error: (error: any) => {
            reject(toError(error));
          }
        });
      });
    } else {
      return new Promise((resolve, reject) => {
        let fullData: any[] = [];

        this.client.execute({
          query,
          schema: this.config.schema || 'default',
          data: (error: any, data: any[], columns: TableStructure) => {
            const normalData = this.normalizeResultOverColumns(data, columns);
            fullData = concat(normalData, fullData);
          },
          success: () => {
            resolve(fullData);
          },
          error: (error: any) => {
            reject(toError(error));
          }
        });
      });
    }
  }

  public downloadQueryResults(query: string, values: unknown[], options: DownloadQueryResultsOptions): Promise<DownloadQueryResultsResult> {
    if (options.streamImport) {
      return <Promise<DownloadQueryResultsResult>> this.stream(query, values, options);
    }
    return super.downloadQueryResults(query, values, options);
  }

  protected override informationSchemaQuery() {
    const catalogPrefix = this.catalog ? `${this.catalog}.` : '';
    const schemaFilter = this.config.schema ? ` AND columns.table_schema = '${this.config.schema}'` : '';

    return `
      SELECT columns.column_name as ${this.quoteIdentifier('column_name')},
             columns.table_name as ${this.quoteIdentifier('table_name')},
             columns.table_schema as ${this.quoteIdentifier('table_schema')},
             columns.data_type as ${this.quoteIdentifier('data_type')}
      FROM ${catalogPrefix}information_schema.columns
      WHERE columns.table_schema NOT IN ('pg_catalog', 'information_schema', 'mysql', 'performance_schema', 'sys', 'INFORMATION_SCHEMA')${schemaFilter}
   `;
  }

  protected override getSchemasQuery() {
    const catalogPrefix = this.catalog ? `${this.catalog}.` : '';

    return `
      SELECT table_schema as ${this.quoteIdentifier('schema_name')}
      FROM ${catalogPrefix}information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema', 'mysql', 'performance_schema', 'sys', 'INFORMATION_SCHEMA')
      GROUP BY table_schema
    `;
  }

  protected override getTablesForSpecificSchemasQuery(schemasPlaceholders: string) {
    const catalogPrefix = this.catalog ? `${this.catalog}.` : '';

    const query = `
      SELECT table_schema as ${this.quoteIdentifier('schema_name')},
            table_name as ${this.quoteIdentifier('table_name')}
      FROM ${catalogPrefix}information_schema.tables as columns
      WHERE table_schema IN (${schemasPlaceholders})
    `;
    return query;
  }

  protected override getColumnsForSpecificTablesQuery(conditionString: string) {
    const catalogPrefix = this.catalog ? `${this.catalog}.` : '';

    const query = `
      SELECT columns.column_name as ${this.quoteIdentifier('column_name')},
             columns.table_name as ${this.quoteIdentifier('table_name')},
             columns.table_schema as ${this.quoteIdentifier('schema_name')},
             columns.data_type as ${this.quoteIdentifier('data_type')}
      FROM ${catalogPrefix}information_schema.columns as columns
      WHERE ${conditionString}
    `;

    return query;
  }

  public normalizeResultOverColumns(data: any[], columns: TableStructure) {
    const columnNames = map(prop('name'), columns || []);
    const arrayToObject = zipObj(columnNames);
    return map(arrayToObject, data || []);
  }

  public stream(query: string, values: unknown[], _options: StreamOptions): Promise<StreamTableData> {
    const queryWithParams = this.prepareQueryWithParams(query, values);

    return <Promise<StreamTableData>> this.queryPromised(queryWithParams, true);
  }

  public capabilities(): DriverCapabilities {
    return {
      unloadWithoutTempTable: true
    };
  }

  public async createSchemaIfNotExists(schemaName: string) {
    await this.query(
      `CREATE SCHEMA IF NOT EXISTS ${this.config.catalog}.${schemaName}`,
      [],
    );
  }

  // Export bucket methods
  public async isUnloadSupported() {
    return this.config.unloadBucket !== undefined
      && this.config.unloadPrefix !== undefined
      && this.config.unloadCatalog !== undefined
      && this.config.unloadSchema !== undefined;
  }

  public async unload(tableName: string, options: UnloadOptions): Promise<TableCSVData> {
    const columns = await this.unloadWithSql(tableName, options);
    const files = await this.getCsvFiles(tableName);
    const unloadSchema = this.config.unloadSchema!;
    const unloadCatalog = this.config.unloadCatalog!;
    const trinoTable = `${unloadCatalog}.${unloadSchema}."${tableName}"`;

    return {
      csvFile: files,
      types: columns,
      csvNoHeader: true,
      csvDelimiter: '^A',
      csvDisableQuoting: true,
      release: async () => {
        try {
          const dropIfExistsSql = `DROP TABLE IF EXISTS ${trinoTable}`;
          await this.queryPromised(this.prepareQueryWithParams(dropIfExistsSql, []), false);
        } catch (_e) {
        }
      }
    };
  }

  private async unloadWithSql(
    tableName: string,
    unloadOptions: UnloadOptions,
  ): Promise<TableStructure> {
    const unloadSchema = this.config.unloadSchema!;
    const unloadCatalog = this.config.unloadCatalog!;
    const trinoTable = `${unloadCatalog}.${unloadSchema}."${tableName}"`;

    const dropIfExistsSql = `DROP TABLE IF EXISTS ${trinoTable}`;
    await this.query(dropIfExistsSql, []);

    const unloadSql = `
        CREATE TABLE ${unloadCatalog}.${unloadSchema}."${tableName}"
        WITH (FORMAT='TEXTFILE') AS ${unloadOptions.query!.sql}
      `;
    await this.query(unloadSql, unloadOptions.query!.params);
    const columns = await this.tableColumns(unloadCatalog, unloadSchema, tableName);

    return columns;
  }

  private async tableColumns(catalog: string, schema: string, table: string): Promise<TableStructure> {
    const columns = await this.query(
      `SELECT columns.column_name as ${this.quoteIdentifier('column_name')},
             columns.table_name as ${this.quoteIdentifier('table_name')},
             columns.table_schema as ${this.quoteIdentifier('table_schema')},
             columns.data_type  as ${this.quoteIdentifier('data_type')}
      FROM information_schema.columns
      WHERE table_catalog = ${this.param(0)} AND table_schema = ${this.param(1)} AND table_name = ${this.param(2)}`,
      [catalog, schema, table]
    );

    return columns.map(c => ({ name: c.column_name, type: this.toGenericType(c.data_type) }));
  }

  public async getCsvFiles(tableName: string): Promise<string[]> {
    const client = (typeof this.config.s3Client !== 'undefined')
      ? this.config.s3Client!
      : new S3({
        region: this.config.region!,
        maxAttempts: 10,
        retryMode: 'adaptive'
      });

    const list = await client.listObjectsV2({
      Bucket: this.config.unloadBucket!,
      Prefix: `${this.config.unloadPrefix}/${tableName}`,
    });
    if (!list.Contents) {
      return [];
    } else {
      const files = await Promise.all(
        list.Contents.map(async (file) => {
          const command = new GetObjectCommand({
            Bucket: this.config.unloadBucket,
            Key: file.Key,
          });
          return getSignedUrl(client, command, { expiresIn: 3600 });
        })
      );

      return files;
    }
  }
}
