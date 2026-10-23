import typeorm from "typeorm"

export class AddSuggestionDashboardPosts1792753200000
    implements typeorm.MigrationInterface
{
    public async up(queryRunner: typeorm.QueryRunner): Promise<void> {
        await queryRunner.createTable(
            new typeorm.Table({
                name: "suggestion_dashboard_posts",
                columns: [
                    { name: "key", type: "varchar", length: "100", isPrimary: true },
                    { name: "messageId", type: "varchar", length: "20" }
                ]
            }),
            true
        )
    }

    public async down(queryRunner: typeorm.QueryRunner): Promise<void> {
        await queryRunner.dropTable("suggestion_dashboard_posts", true)
    }
}
