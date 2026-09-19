# Discord suggestion dashboard

The dashboard runs inside the existing bot. It has no website, separate bot or duplicate suggestion store. Every search reads the existing `suggestions` table.

## Using the dashboard

-   `/suggestion-dashboard` opens a private, ephemeral menu with the newest Main **and** Staff suggestions.
-   **Search / dates** searches the title and full description, regardless of case. `%` and `_` are treated literally.
-   Filter by **status**, **date range** and optionally **server**. Unanswered includes NULL, an empty status and `open`.
-   Choose all dates, the previous calendar week, the last 7/30/90 days, or inclusive custom dates in `YYYY-MM-DD` format.
-   Set **Your timezone** in **Search / dates**, for example `Europe/Amsterdam` or `America/New_York`. Discord does not expose your device timezone to bots. Until you choose one, the menu explicitly shows the server default. Your choice is saved per user in `suggestion_dashboard_preferences` and survives restarts. Date filters use midnight in that timezone, including daylight saving changes; Reset keeps your timezone. Existing open menus keep their current timezone until reopened or edited.
-   Weekly public totals and publication time use the configured server timezone. Opening a weekly menu uses the dates on that post in your saved timezone, so its private total may differ near the date boundaries.
-   **Previous / Next** show five suggestions per page. Filters are preserved; changing a filter returns to page one. **Reset** clears all filters.
-   **Open in Discord** links to the original suggestion. Anonymous authors are not disclosed.
-   Only the weekly launcher is posted to the channel. Search terms, menus, results and errors are visible only to the person using them.

The MVP focuses on finding and filtering suggestions. Status changes and other moderation remain in the existing `/suggestion` commands.

## Configuration

Add this to your local, Git-ignored `config/config.json5`:

```json5
suggestionDashboard: {
    enabled: true,
    channelId: "",
    channelName: "suggestions", // Use channelId instead if this name is not unique
    reviewerRoleIds: [],       // Optional additional reviewer role IDs
    timezone: "Europe/Amsterdam"
},
```

The channel must be a regular text channel in `guilds.staff`. Restrict its visibility to Admins, Managers and reviewers. The bot needs **View Channel**, **Send Messages**, **Embed Links** and **Read Message History**. The dashboard does not modify channel permissions.

Every interaction checks access again: Discord Administrator permission, an existing `ADMIN` or `MANAGER` role mapping, or a role in `reviewerRoleIds`. Generic staff roles and developer bypasses do not automatically grant access. The interaction must take place in the Staff server. Sessions belong to one user, expire after 30 minutes of inactivity and are invalidated by a bot restart. Weekly launcher buttons remain usable after restarts.

## Local Jasupa setup

A local `config/config.json5` has been prepared for server `511539230657347584`, with the dashboard enabled in `#suggestions`. The local token, database credentials and suggestion channel IDs have been configured. Secrets are only stored in ignored local files.

Both guild IDs point to the same server for this initial test. The existing bot requires both guilds to be available. With identical IDs, its command registration runs twice against that server and `/suggest` creates Staff-category suggestions. Use two servers to test actual Main/Staff separation. The included test-server role mapping sets `ANY` to that server's everyone role; dashboard administrators are recognized through Discord permissions.

Complete the remaining bot settings:

1. Connect to an empty local MariaDB/MySQL database using `database.host`, `name`, `user` and `pass`. Local defaults are `127.0.0.1`, `bte_local` and `bte`. The local setup now includes a portable MariaDB installation under `.local/`, with database `bte_local` and a dedicated bot user. Credentials are kept in ignored local files. The existing bot automatically synchronizes its schema, so do not use a production database.
2. Set the existing `suggestions.main`, `suggestions.staff` and `suggestions.discussion.main` / `.staff` to your suggestion channel IDs. These are separate from the dashboard's channel name lookup. Use the same channel IDs for a single-server test if desired. Existing `/suggest` needs its normal message, reaction and thread permissions.
3. Configure logging and any role mappings needed by other bot features. The local suggestion offsets start at 1 to avoid the existing first-suggestion numbering issue.
4. Enable Server Members and Message Content intents for the test bot in Discord, and invite it with the `bot` and `applications.commands` scopes.

Compile and run from the project root:

```powershell
npx.cmd tsc --noEmit
npx.cmd tsc
node --unhandled-rejections=strict dist/index.js
```

Once the bot is ready, it posts the latest due weekly launcher in the configured channel. Admins and Managers can also use `/suggestion-dashboard publish:true` to post or retrieve that week's launcher without duplicating an existing one.

## Weekly update

Every Monday at **09:00 Europe/Amsterdam**, the bot posts an overview for the previous calendar week, Monday 00:00 through the next Monday 00:00. Date ranges include daylight saving time changes. The channel message contains a count and launcher buttons; suggestion text appears only after the private menu's role check.

**Browse previous week** retains the exact dates encoded in that post. Old posts therefore continue to open the correct week. Search results always come from the current database, so no separate data sync is needed.

On startup, the bot catches up with the latest due publication instead of posting every missed week. The new `suggestion_dashboard_posts` table stores channel/week and message ID. Existing TypeORM synchronization creates this table. If the process crashes after sending but before saving, the bot also checks the last 100 channel messages for the publication marker. Run one bot process for publishing; this MVP has no distributed lock across bot instances. After a failed publication, check logs/permissions and use `publish:true` or restart.

## Verification

```powershell
npm.cmd run test:suggestion-dashboard
```

The tests require Node.js 22.13+ (or 24+) for its built-in SQLite test driver. They need no Discord token or running database. They cover real SQL filtering against temporary SQLite fixtures, timezone boundaries, permissions, private sessions, pagination, Discord embed/component limits and weekly deduplication with mocked Discord/database connections. SQLite is only a test fixture, not a replacement for the bot's MariaDB/MySQL database.

For a live test:

1. Submit a few suggestions using the existing `/suggest` command.
2. Open `/suggestion-dashboard` as an Admin. Confirm that the reply is private.
3. Search for a word only in a description; also test no results.
4. Combine status, dates and source; test multiple pages with more than five suggestions.
5. Open menus as two reviewers at once; their filters must remain independent.
6. Try an unauthorized account and remove a reviewer's role during a session; both must be denied.
7. Restart the bot: no duplicate weekly launcher, and old private sessions report expiry.

Compilation and mocked tests do not verify Discord login or a live MariaDB connection. Those require the local credentials and server configuration above.
