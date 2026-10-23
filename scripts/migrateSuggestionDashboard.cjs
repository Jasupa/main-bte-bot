// Run only the dashboard migration, without starting Discord or synchronizing entities.
const fs = require("fs")
const path = require("path")
const JSON5 = require("json5")
const typeorm = require("typeorm")

async function main() {
    const config = JSON5.parse(
        fs.readFileSync(path.join(__dirname, "../config/config.json5"), "utf8")
    ).database
    const type = process.env.DB_TYPE || config.type
    if (!["mysql", "mariadb", "sqlite"].includes(type))
        throw new Error("Unsupported database type")
    const { AddSuggestionDashboardPosts1792753200000 } = await import(
        "../dist/migrations/1792753200000-AddSuggestionDashboardPosts.js"
    )
    const connection = await typeorm.createConnection({
        ...(type === "sqlite"
            ? { type: "better-sqlite3", database: process.env.DB_PATH || config.path }
            : {
                  type,
                  host: process.env.DB_HOST || config.host,
                  database: process.env.DB_NAME || config.name,
                  username: process.env.DB_USER || config.user,
                  password: process.env.DB_PASS || config.pass,
                  charset: "utf8mb4"
              }),
        synchronize: false,
        migrations: [AddSuggestionDashboardPosts1792753200000]
    })
    try {
        await connection.runMigrations()
        console.log("Suggestion dashboard migration complete.")
    } finally {
        await connection.close()
    }
}

main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
})
