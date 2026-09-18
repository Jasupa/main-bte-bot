import typeorm from "typeorm"

// Persist the publication marker so restarting the bot does not repost the same week.
@typeorm.Entity({ name: "suggestion_dashboard_posts" })
export default class SuggestionDashboardPost extends typeorm.BaseEntity {
    @typeorm.PrimaryColumn({ length: 100 })
    key!: string

    @typeorm.Column({ length: 20 })
    messageId!: string
}
