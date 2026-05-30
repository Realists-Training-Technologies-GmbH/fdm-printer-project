import { MigrationInterface, QueryRunner } from "typeorm";

export class AddIntakeItem1779700000000 implements MigrationInterface {
  name = "AddIntakeItem1779700000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "intake_item"
      (
        "id"               integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "createdAt"        datetime                          NOT NULL DEFAULT (datetime('now')),
        "source"           varchar                           NOT NULL DEFAULT ('prusaslicer'),
        "sourceMetadata"   json,
        "originalFileName" varchar                           NOT NULL,
        "fileFormat"       varchar,
        "fileSize"         integer                           NOT NULL DEFAULT (0),
        "fileHash"         varchar,
        "stagingPath"      varchar,
        "metadata"         json,
        "quantity"         integer                           NOT NULL DEFAULT (1),
        "status"           varchar                           NOT NULL DEFAULT ('PENDING'),
        "resolvedAt"       datetime,
        "resolvedByUserId" integer,
        "resolvedBy"       varchar,
        CONSTRAINT "FK_intake_item_resolved_by_user" FOREIGN KEY ("resolvedByUserId") REFERENCES "user" ("id") ON DELETE
          SET NULL ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_intake_item_status" ON "intake_item" ("status")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_intake_item_status"`);
    await queryRunner.query(`DROP TABLE "intake_item"`);
  }
}
