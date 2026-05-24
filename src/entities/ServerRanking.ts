import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index, Unique } from 'typeorm'

import { Server } from './Server'

@Entity('server_rankings')
@Unique('uq_server_rankings_server_id_calculated_at', ['serverId', 'calculatedAt'])
@Index('idx_server_rankings_server_id_calculated_at', ['serverId', 'calculatedAt'])
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

  @Column({ name: 'calculated_at', type: 'timestamptz' })
  calculatedAt!: Date
}
