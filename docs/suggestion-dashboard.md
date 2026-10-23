# Testing the suggestion dashboard

## Requirements and configuration

Use a separate Discord application, two test guilds (Main and Staff), and a disposable MySQL/MariaDB database. SQLite is listed by the bot but currently documented as broken in installation.md; use MySQL/MariaDB for this walkthrough. No production credentials are needed.

1. Run `npm ci`. Copy `config/_config.json5` to `config/config.json5` (keep the template).
2. Set `token` to your test bot token, `guilds.main` and `guilds.staff` to your test guild IDs, and `database` to your test database connection. `TOKEN`, `DB_TYPE`, `DB_HOST`, `DB_NAME`, `DB_USER`, and `DB_PASS` can override those values through the environment.
3. Enable the Guild Members and Message Content privileged intents in the application's Bot settings. Invite the bot to both guilds with the `bot` and `applications.commands` scopes. Grant View Channel, Send Messages, Embed Links, Read Message History, Add Reactions, Create Public Threads, and Send Messages in Threads in the suggestion channels.
4. Set `suggestions.main` and `suggestions.staff` to the suggestion channels. Set `suggestionDashboard.enabled` to `true` and `suggestionDashboard.channels.main` / `.staff` to the weekly-menu channels. The weekly-menu channels require View Channel, Send Messages, Embed Links, and Read Message History. Keep Staff channels private.
5. Copy the existing Main and Staff role specification files in `config/extensions/roles/` to `<test-guild-id>.json5` files. Replace role IDs with your test roles; set `ANY` to each test guild's ID. Set `SUGGESTION_DASHBOARD` to the Builder role ID in Main and to the Staff guild ID in Staff (everyone). Both the slash command and dashboard interactions use this mapping through the existing permission system. Remove the obsolete `mainAccessRoleId` / `accessRoleId` from your configuration.
6. Set `images.bindPort` to an unused local port. For a full bot startup, configure the other logging/channel/role settings described in [installation.md](../installation.md) for your test guilds too; the bot also initializes unrelated services. External API keys for unrelated commands are not needed to browse suggestions. Do not add test accounts to `developers` when checking denied access: the existing permission system gives developers a bypass.

## Migration and startup

Build without deleting the output directory, then apply only the dashboard migration:

```powershell
npx tsc
npm start migrate_suggestion_dashboard
npm start
```

The migration creates `suggestion_dashboard_posts` with a 100-character primary `key` and 20-character `messageId`. It uses the configured database and the same database environment overrides as the bot. It does not log into Discord or run entity synchronization. Re-running it is safe: TypeORM records applied migrations, and creation also tolerates an existing table from an earlier synchronized deployment.

For production, back up the database, stop the bot, build, run the migration command, and restart the bot. Startup currently has `synchronize: true`; the explicit migration makes creation independent of that setting. The migration's `down` removes publication tracking; existing Discord messages remain. Do not run historical migrations against an already synchronized production schema merely to add this table.

## Manual checks

- Submit one Main and one Staff suggestion with distinguishable titles using `/suggest`. Confirm one acknowledgement per submission and no interaction-already-replied error.
- As a Main Builder, open `/suggestion-dashboard`. Search a known title and description; change status/date filters; reset; refresh; navigate pages (submit six suggestions to exercise pagination). Only Main suggestions should be returned.
- As a Main member without the configured role, verify access is denied. Verify `publish: true` is denied in Main even for a Builder.
- As a Staff member, browse Main and Staff suggestions and use the source filter. Run `/suggestion-dashboard publish:true`; verify one weekly menu in each configured channel. Search results must be private to the caller.
- Run the publish command again, restart the bot, and reconnect. Verify the existing weekly messages are reused without editing or duplicating them. Weekly publication is Monday at 09:00 UTC; before that time the previous scheduled period is used.
- Click another user's session buttons and verify they cannot operate that session. Remove a Main user's configured role during a session and verify subsequent interactions are denied. Verify an expired session asks the user to open a new menu.

Static checks that require neither Discord nor a database:

```powershell
npx tsc --noEmit
npx prettier --check src/struct/client/SuggestionDashboard.ts src/commands/suggestion-dashboard.command.ts src/struct/client/ConfigManager.ts src/migrations/1792753200000-AddSuggestionDashboardPosts.ts
git diff --check
```
