import { MigrationInterface, QueryRunner } from 'typeorm'

// Three storage levels next to online_records, which stays as it is:
//   online_raw    one point per server per 15-minute collection, kept 48 hours, one partition per day
//   online_hourly one row per server per hour, kept 90 days, one partition per month
//   online_daily  one row per server per day, kept forever
// plus game_hourly: one row per game per hour, kept forever.
// Partitions are created and dropped by the storage job, not here.
export class TieredStorage1794963600000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // recorded_at goes first so the row has no alignment padding: 16 bytes of data instead of 32 in online_records.
    // No surrogate id, no max_players per point (it lives in servers), no foreign key on the hot insert path.
    await queryRunner.query(`
      CREATE TABLE online_raw (
        recorded_at timestamptz NOT NULL,
        server_id   integer     NOT NULL,
        players     smallint    NOT NULL,
        bots        smallint    NOT NULL DEFAULT 0,
        PRIMARY KEY (server_id, recorded_at)
      ) PARTITION BY RANGE (recorded_at)
    `)
    // points arrive in time order, so a block-range index finds an hour of all servers at a few kilobytes of size
    await queryRunner.query(`CREATE INDEX online_raw_recorded_at_brin ON online_raw USING brin (recorded_at)`)

    // samples = slots of the hour that have a point (1..4). A slot without a point is 0 players,
    // so the hourly average is players_sum / collections in that hour, never players_sum / samples.
    await queryRunner.query(`
      CREATE TABLE online_hourly (
        hour        timestamptz NOT NULL,
        server_id   integer     NOT NULL,
        players_sum integer     NOT NULL,
        bots_sum    integer     NOT NULL,
        players_max smallint    NOT NULL,
        samples     smallint    NOT NULL,
        PRIMARY KEY (server_id, hour)
      ) PARTITION BY RANGE (hour)
    `)
    await queryRunner.query(`CREATE INDEX online_hourly_hour_brin ON online_hourly USING brin (hour)`)

    // day is a UTC calendar day; samples = slots of the day that have a point (1..96)
    await queryRunner.query(`
      CREATE TABLE online_daily (
        day         date     NOT NULL,
        server_id   integer  NOT NULL,
        players_sum integer  NOT NULL,
        bots_sum    integer  NOT NULL,
        players_max smallint NOT NULL,
        samples     smallint NOT NULL,
        PRIMARY KEY (server_id, day)
      )
    `)
    await queryRunner.query(`CREATE INDEX online_daily_day_brin ON online_daily USING brin (day)`)

    // samples = collections of the hour that returned this game (0..4): players_sum / samples is the average
    // online of the game, and samples < 4 tells a failed collection from an empty hour
    await queryRunner.query(`
      CREATE TABLE game_hourly (
        appid       integer     NOT NULL,
        hour        timestamptz NOT NULL,
        players_sum bigint      NOT NULL,
        servers_sum integer     NOT NULL,
        players_max integer     NOT NULL,
        samples     smallint    NOT NULL,
        PRIMARY KEY (appid, hour)
      )
    `)

    // how far each level is filled: everything before done_until is already rolled up
    await queryRunner.query(`
      CREATE TABLE storage_state (
        name       text        PRIMARY KEY,
        done_until timestamptz NOT NULL
      )
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE storage_state`)
    await queryRunner.query(`DROP TABLE game_hourly`)
    await queryRunner.query(`DROP TABLE online_daily`)
    await queryRunner.query(`DROP TABLE online_hourly`)
    await queryRunner.query(`DROP TABLE online_raw`)
  }
}
