import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Unique, OneToMany } from 'typeorm'

import { OnlineRecord } from './OnlineRecord'

@Entity('servers')
@Unique(['ip', 'queryPort'])
export class Server {
  @PrimaryGeneratedColumn()
  id!: number

  @Column({ type: 'varchar' })
  ip!: string

  @Column({ name: 'query_port', type: 'int' })
  queryPort!: number

  @Column({ name: 'game_port', type: 'int' })
  gamePort!: number

  @Column({ type: 'varchar' })
  steamid!: string

  @Column({ type: 'varchar' })
  name!: string

  @Column({ type: 'int' })
  appid!: number

  @Column({ type: 'varchar' })
  version!: string

  @Column({ type: 'varchar' })
  map!: string

  @Column({ name: 'is_secure', type: 'boolean' })
  isSecure!: boolean

  @Column({ name: 'is_dedicated', type: 'boolean' })
  isDedicated!: boolean

  @Column({ type: 'varchar', length: 4 })
  os!: string

  @Column({ type: 'int' })
  region!: number

  @Column({ name: 'gametype_raw', type: 'text' })
  gametypeRaw!: string

  @Column({ name: 'gametype_tags', type: 'jsonb' })
  gametypeTags!: string[]

  @Column({ name: 'max_players', type: 'int', default: 0 })
  maxPlayers!: number

  @Column({ name: 'is_online', type: 'boolean', default: true })
  isOnline!: boolean

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date

  @Column({ name: 'last_seen_at', type: 'timestamptz' })
  lastSeenAt!: Date

  @OneToMany(() => OnlineRecord, (record) => record.server)
  onlineRecords!: OnlineRecord[]
}
