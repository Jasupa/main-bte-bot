import typeorm from "typeorm"

@typeorm.Entity({ name: "suggestion_dashboard_preferences" })
export default class SuggestionDashboardPreference extends typeorm.BaseEntity {
    @typeorm.PrimaryColumn({ length: 20 })
    userId!: string

    @typeorm.Column({ length: 100 })
    timezone!: string
}
