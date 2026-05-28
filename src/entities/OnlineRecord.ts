import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index } from 'typeorm'

import { Server } from './Server'

@Entity('online_records')
@Index('idx_online_records_server_id_recorded_at', ['serverId', 'recordedAt'])
@Index('idx_online_records_recorded_at', ['recordedAt'])
export class OnlineRecord {
  @PrimaryGeneratedColumn()
  id!: number

  @Column({ name: 'server_id', type: 'int' })
  serverId!: number

  @ManyToOne(() => Server, (server) => server.onlineRecords, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'server_id' })
  server!: Server

  @Column({ type: 'int' })
  players!: number

  @Column({ name: 'max_players', type: 'int' })
  maxPlayers!: number

  @Column({ name: 'recorded_at', type: 'timestamptz' })
  recordedAt!: Date
}
