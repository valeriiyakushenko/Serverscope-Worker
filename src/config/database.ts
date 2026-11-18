import { DataSource } from 'typeorm'

import { Server } from '../entities/Server'
import { OnlineRecord } from '../entities/OnlineRecord'
import { ServerRanking } from '../entities/ServerRanking'
import { Game } from '../entities/Game'
import { Baseline1794960000000 } from '../migrations/1794960000000-Baseline'

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  entities: [Server, OnlineRecord, ServerRanking, Game],
  // the schema changes only through src/migrations: an edited entity file never alters a table on its own
  synchronize: false,
  migrations: [Baseline1794960000000],
  migrationsTableName: 'worker_migrations', // "migrations" in this database belongs to the API
  logging: process.env.NODE_ENV === 'development',
})
