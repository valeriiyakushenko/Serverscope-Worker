import { MigrationInterface, QueryRunner } from 'typeorm'

// The four tables that schema sync used to create, statement for statement.
// A database that already has them (the running one) is left untouched.
export class Baseline1794960000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('servers')) return

    await queryRunner.query(
      `CREATE TABLE "games" ("id" SERIAL NOT NULL, "appid" integer NOT NULL, "name" character varying NOT NULL, "image_link" character varying, "players" integer NOT NULL DEFAULT '0', "servers" integer NOT NULL DEFAULT '0', "hourly_online" jsonb NOT NULL DEFAULT '[]', "updated_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "UQ_b651df423c1f9ee682d78cf0fb4" UNIQUE ("appid"), CONSTRAINT "PK_c9b16b62917b5595af982d66337" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(
      `CREATE TABLE "servers" ("id" SERIAL NOT NULL, "ip" character varying NOT NULL, "query_port" integer NOT NULL, "game_port" integer NOT NULL, "steamid" character varying NOT NULL, "name" character varying NOT NULL, "appid" integer NOT NULL, "version" character varying NOT NULL, "map" character varying NOT NULL, "is_secure" boolean NOT NULL, "is_dedicated" boolean NOT NULL, "os" character varying(4) NOT NULL, "region" integer NOT NULL, "gametype_raw" text NOT NULL, "gametype_tags" jsonb NOT NULL, "max_players" integer NOT NULL DEFAULT '0', "players" integer NOT NULL DEFAULT '0', "bots" integer NOT NULL DEFAULT '0', "rank" integer NOT NULL DEFAULT '0', "hourly_online" jsonb NOT NULL DEFAULT '[]', "is_online" boolean NOT NULL DEFAULT true, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL, "last_seen_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "UQ_91700179d6d0dd8eb722ea8c00c" UNIQUE ("ip", "query_port"), CONSTRAINT "PK_c0947efd9f3db2dcc010164d20b" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(`CREATE INDEX "idx_servers_appid_rank" ON "servers" ("appid", "rank")`)
    await queryRunner.query(
      `CREATE TABLE "online_records" ("id" SERIAL NOT NULL, "server_id" integer NOT NULL, "players" integer NOT NULL, "bots" integer NOT NULL DEFAULT '0', "max_players" integer NOT NULL, "recorded_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_ec8b7fc5bd84b72412ef8564c90" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(`CREATE INDEX "idx_online_records_recorded_at" ON "online_records" ("recorded_at")`)
    await queryRunner.query(
      `CREATE INDEX "idx_online_records_server_id_recorded_at" ON "online_records" ("server_id", "recorded_at")`,
    )
    await queryRunner.query(
      `CREATE TABLE "server_rankings" ("id" SERIAL NOT NULL, "server_id" integer NOT NULL, "appid" integer NOT NULL, "median_players" numeric(10,2) NOT NULL, "rank" integer NOT NULL, "empty_count" integer NOT NULL DEFAULT '0', "uptime_ratio" numeric(6,4) NOT NULL DEFAULT '0', "historical_rank_avg" numeric(6,4) NOT NULL DEFAULT '0.5', "score" numeric(6,4) NOT NULL DEFAULT '0', "popularity" numeric(7,2) NOT NULL DEFAULT '0', "stability" numeric(6,4) NOT NULL DEFAULT '0', "calculated_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_f22458387dc2315872b41cf1370" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(
      `CREATE INDEX "idx_server_rankings_appid_calculated_at_rank" ON "server_rankings" ("appid", "calculated_at", "rank")`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_server_rankings_server_id_calculated_at" ON "server_rankings" ("server_id", "calculated_at")`,
    )
    await queryRunner.query(
      `ALTER TABLE "online_records" ADD CONSTRAINT "FK_e95b79f9052695c9ac343173d90" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    )
    await queryRunner.query(
      `ALTER TABLE "server_rankings" ADD CONSTRAINT "FK_048961064fe074a8d11f9d87281" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    )
  }

  // Dropping the collected history is never the right way back, so there is no down step.
  public async down(): Promise<void> {}
}
