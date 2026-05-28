import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index } from 'typeorm'

import { Server } from './Server'

@Entity('server_rankings')
@Index('idx_server_rankings_server_id_calculated_at', ['serverId', 'calculatedAt'], { unique: true })
@Index('idx_server_rankings_appid_calculated_at_rank', ['appid', 'calculatedAt', 'rank'])
export class ServerRanking {
  @PrimaryGeneratedColumn()
  id!: number

  @Column({ name: 'server_id', type: 'int' })
  serverId!: number

  @ManyToOne(() => Server, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'server_id' })
  server!: Server

  @Column({ type: 'int' })
  appid!: number

  @Column({ name: 'median_players', type: 'numeric', precision: 10, scale: 2 })
  medianPlayers!: number

  @Column({ type: 'int' })
  rank!: number

  @Column({ name: 'empty_count', type: 'int', default: 0 })
  emptyCount!: number

  @Column({ name: 'uptime_ratio', type: 'numeric', precision: 6, scale: 4, default: 0 })
  uptimeRatio!: number

  @Column({ name: 'historical_rank_avg', type: 'numeric', precision: 6, scale: 4, default: 0.5 })
  historicalRankAvg!: number

  @Column({ type: 'numeric', precision: 6, scale: 4, default: 0 })
  score!: number

  @Column({ type: 'numeric', precision: 7, scale: 2, default: 0 })
  popularity!: number

  @Column({ type: 'numeric', precision: 6, scale: 4, default: 0 })
  stability!: number

  @Column({ name: 'calculated_at', type: 'timestamptz' })
  calculatedAt!: Date
}
