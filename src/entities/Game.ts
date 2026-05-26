import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm'

@Entity('games')
export class Game {
  @PrimaryGeneratedColumn()
  id!: number

  @Column({ type: 'int', unique: true })
  appid!: number

  @Column({ type: 'varchar' })
  name!: string

  @Column({ name: 'image_link', type: 'varchar', nullable: true })
  imageLink!: string | null

  @Column({ type: 'int', default: 0 })
  players!: number

  @Column({ type: 'int', default: 0 })
  servers!: number

  @Column({ name: 'hourly_online', type: 'jsonb', default: [] })
  hourlyOnline!: number[]

  @Column({ name: 'updated_at', type: 'timestamptz', nullable: true })
  updatedAt!: Date | null
}
