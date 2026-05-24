import { DataSource } from 'typeorm'

import { Server } from '../entities/Server'
import { OnlineRecord } from '../entities/OnlineRecord'
import { ServerRanking } from '../entities/ServerRanking'

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  entities: [Server, OnlineRecord, ServerRanking],
  synchronize: true,
  logging: process.env.NODE_ENV === 'development',
})
