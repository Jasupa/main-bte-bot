import "reflect-metadata"
import { test } from "node:test"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import {
    Collection,
    MessageFlags,
    PermissionsBitField,
    PermissionFlagsBits,
    TextChannel
} from "discord.js"
import Dashboard from "../dist/struct/client/SuggestionDashboard.js"
import DashboardPost from "../dist/entities/SuggestionDashboardPost.entity.js"
import {
    calendarDate,
    previousWeek,
    midnight,
    filterSql,
    validateFilters,
    validDate,
    canReview
} from "../dist/util/suggestionDashboard.util.js"

const filters = (overrides = {}) => ({
    query: "",
    status: "all",
    source: "all",
    from: "",
    to: "",
    ...overrides
})
function clientFixture() {
    return {
        config: {
            guilds: { main: "main", staff: "staff" },
            suggestions: { main: "main-channel", staff: "staff-channel" },
            suggestionDashboard: {
                enabled: true,
                channelId: "dashboard",
                reviewerRoleIds: ["reviewer"],
                timezone: "Europe/Amsterdam"
            }
        },
        roles: { ADMIN: ["admin"], MANAGER: ["manager"] },
        user: { id: "bot" },
        logger: { error() {} },
        channels: { fetch: async () => null }
    }
}
function interactionFixture({
    customId = "",
    user = "alice",
    roles = ["reviewer"],
    guild = "staff",
    administrator = false,
    values,
    modal
} = {}) {
    const calls = []
    const interaction = {
        calls,
        customId,
        user: { id: user },
        guildId: guild,
        member: { roles },
        memberPermissions: new PermissionsBitField(
            administrator ? PermissionFlagsBits.Administrator : 0n
        ),
        isButton: () => !values && !modal,
        isStringSelectMenu: () => Boolean(values),
        isModalSubmit: () => Boolean(modal),
        values,
        fields: { getTextInputValue: key => modal?.[key] || "" },
        isFromMessage: () => true,
        async reply(payload) {
            calls.push(["reply", payload])
            this.replied = true
        },
        async deferReply(payload) {
            calls.push(["deferReply", payload])
            this.deferred = true
        },
        async deferUpdate() {
            calls.push(["deferUpdate"])
            this.deferred = true
        },
        async editReply(payload) {
            calls.push(["editReply", payload])
        },
        async followUp(payload) {
            calls.push(["followUp", payload])
        },
        async showModal(payload) {
            calls.push(["showModal", payload.toJSON()])
        }
    }
    return interaction
}
function useRows(dashboard, count = 12) {
    const rows = Array.from({ length: count }, (_, id) => ({
        id: id + 1,
        number: id + 1,
        title: "Title ".repeat(40),
        body: "Description ".repeat(150),
        status: id % 2 ? "approved" : null,
        staff: Boolean(id % 2),
        createdAt: new Date("2026-09-15T12:00:00Z"),
        getURL: () => "https://discord.com/channels/1/2/3"
    }))
    const queries = []
    dashboard.search = selected => {
        queries.push({ ...selected })
        let offset = 0
        let size = 5
        const query = {
            getCount: async () => rows.length,
            skip(value) {
                offset = value
                return query
            },
            take(value) {
                size = value
                return query
            },
            getMany: async () => rows.slice(offset, offset + size)
        }
        return query
    }
    return queries
}

test("calendar weeks and inclusive dates follow Amsterdam daylight saving time", () => {
    assert.deepEqual(previousWeek(new Date("2026-09-14T10:00:00Z"), "Europe/Amsterdam"), {
        from: "2026-09-07",
        to: "2026-09-13",
        monday: "2026-09-14"
    })
    assert.equal(
        calendarDate(new Date("2026-09-13T22:30:00Z"), "Europe/Amsterdam"),
        "2026-09-14"
    )
    assert.equal(
        midnight("2026-03-29", "Europe/Amsterdam").toISOString(),
        "2026-03-28T23:00:00.000Z"
    )
    assert.equal(
        midnight("2026-03-30", "Europe/Amsterdam").toISOString(),
        "2026-03-29T22:00:00.000Z"
    )
    assert.equal(
        midnight("2026-10-25", "Europe/Amsterdam").toISOString(),
        "2026-10-24T22:00:00.000Z"
    )
    assert.equal(
        midnight("2026-10-26", "Europe/Amsterdam").toISOString(),
        "2026-10-25T23:00:00.000Z"
    )
    for (const date of ["2026-02-30", "2026-13-01", "foo", "2026-00-00"])
        assert.equal(validDate(date), false)
    assert.equal(validDate("2028-02-29"), true)
    assert.throws(() =>
        validateFilters(filters({ from: "2026-09-20", to: "2026-09-01" }))
    )
})

test("actual SQL searches titles and bodies across servers, combines dates/status and escapes wildcards", t => {
    const db = new DatabaseSync(":memory:")
    t.after(() => db.close())
    db.exec(
        "CREATE TABLE suggestions (id INTEGER, title TEXT, body TEXT, status TEXT, staff INTEGER, created_at TEXT, deleted_at TEXT)"
    )
    const insert = db.prepare("INSERT INTO suggestions VALUES (?, ?, ?, ?, ?, ?, ?)")
    insert.run(1, "MAIN idea", "a body", null, 0, "2026-09-13T22:00:00.000Z", null)
    insert.run(2, "Staff idea", "Main topic", "open", 1, "2026-09-14T20:00:00.000Z", null)
    insert.run(3, "Other", "100%_done!", "approved", 1, "2026-09-14T21:59:59.000Z", null)
    insert.run(4, "Main deleted", "text", null, 0, "2026-09-14T12:00:00.000Z", "deleted")
    insert.run(5, "Next day", "main", "", 0, "2026-09-14T22:00:00.000Z", null)
    const search = selected => {
        const { where, params } = filterSql(filters(selected), "Europe/Amsterdam")
        const values = Object.fromEntries(
            Object.entries(params).map(([key, value]) => [
                key,
                value instanceof Date
                    ? value.toISOString()
                    : typeof value === "boolean"
                    ? Number(value)
                    : value
            ])
        )
        return db
            .prepare(`SELECT id FROM suggestions s WHERE ${where} ORDER BY id`)
            .all(values)
            .map(row => row.id)
    }
    assert.deepEqual(search({ query: "main" }), [1, 2, 5])
    assert.deepEqual(
        search({ query: "main", status: "open", from: "2026-09-14", to: "2026-09-14" }),
        [1, 2]
    )
    assert.deepEqual(search({ source: "staff", status: "open" }), [2])
    assert.deepEqual(search({ query: "%_" }), [3])
    assert.deepEqual(search({ query: "' OR 1=1 --" }), [])
})

test("access requires Staff guild and Administrator, Admin, Manager or configured reviewer", () => {
    assert.equal(canReview(true, true, [], []), true)
    assert.equal(canReview(true, false, ["manager"], ["manager"]), true)
    assert.equal(canReview(true, false, ["reviewer"], ["reviewer"]), true)
    assert.equal(canReview(false, true, ["manager"], ["manager"]), false)
    assert.equal(canReview(true, false, ["moderator"], ["reviewer"]), false)
})

test("page boundaries, combined sources and Discord embed/component limits", async () => {
    const dashboard = new Dashboard(clientFixture())
    useRows(dashboard)
    const [id, session] = dashboard.createSession("alice")
    let result = await dashboard.render(id, session)
    assert.equal(result.embeds[0].data.fields.length, 5)
    assert.equal(result.embeds[0].data.title, "Suggestion dashboard · Main & Staff")
    assert.equal(result.components[3].toJSON().components[2].label, "Search / dates")
    assert.match(result.embeds[0].data.fields[0].name, /Main/)
    assert.match(result.embeds[0].data.fields[1].name, /Staff/)
    for (const row of result.components)
        for (const component of row.toJSON().components)
            assert.ok(component.custom_id.length <= 100)
    assert.ok(result.embeds[0].length < 6000)
    assert.equal(result.components[3].toJSON().components[0].disabled, true)
    session.page = 99
    result = await dashboard.render(id, session)
    assert.equal(session.page, 2)
    assert.equal(result.embeds[0].data.fields.length, 2)
    assert.equal(result.components[3].toJSON().components[1].disabled, true)
    session.page = -10
    await dashboard.render(id, session)
    assert.equal(session.page, 0)
    assert.equal(dashboard.modal(id, session).toJSON().components.length, 3)
})

test("open replies ephemerally and rejected users never query suggestion data", async () => {
    const dashboard = new Dashboard(clientFixture())
    const queries = useRows(dashboard)
    const open = interactionFixture()
    await dashboard.open(open)
    assert.equal(open.calls[0][0], "deferReply")
    assert.equal(open.calls[0][1].flags, MessageFlags.Ephemeral)
    const denied = interactionFixture({ roles: [] })
    await dashboard.open(denied)
    assert.equal(denied.calls[0][0], "reply")
    assert.equal(denied.calls[0][1].flags, MessageFlags.Ephemeral)
    assert.equal(queries.length, 1)
})

test("session ownership, expiration and removed permissions are enforced on every click", async () => {
    const dashboard = new Dashboard(clientFixture())
    const queries = useRows(dashboard)
    const [id, session] = dashboard.createSession("alice")
    for (const options of [{ user: "bob" }, { roles: [] }, { guild: "main" }]) {
        const denied = interactionFixture({ customId: `sugd:${id}:next`, ...options })
        assert.equal(await dashboard.handle(denied), true)
        assert.equal(denied.calls[0][1].flags, MessageFlags.Ephemeral)
    }
    session.expires = Date.now() - 1
    const expired = interactionFixture({ customId: `sugd:${id}:next` })
    await dashboard.handle(expired)
    assert.match(expired.calls[0][1].content, /expired/)
    assert.equal(queries.length, 0)
    assert.equal(
        await dashboard.handle(interactionFixture({ customId: "modmenu:other" })),
        false
    )
})

test("filters reset page, stay private and do not change another user session", async () => {
    const dashboard = new Dashboard(clientFixture())
    useRows(dashboard)
    const [id, alice] = dashboard.createSession("alice")
    const [, bob] = dashboard.createSession("bob")
    alice.page = 2
    const select = interactionFixture({
        customId: `sugd:${id}:status`,
        values: ["approved"]
    })
    await dashboard.handle(select)
    assert.equal(select.calls[0][0], "deferUpdate")
    assert.equal(alice.page, 0)
    assert.equal(alice.status, "approved")
    assert.equal(bob.status, "all")
    const modal = interactionFixture({
        customId: `sugd:${id}:filters`,
        modal: { query: "text", from: "2026-09-01", to: "2026-09-18" }
    })
    await dashboard.handle(modal)
    assert.equal(alice.query, "text")
    assert.equal(alice.from, "2026-09-01")
    assert.equal(alice.status, "approved")
    assert.equal(bob.query, "")
    const invalid = interactionFixture({
        customId: `sugd:${id}:filters`,
        modal: { from: "2026-13-01" }
    })
    await dashboard.handle(invalid)
    assert.equal(invalid.calls[0][0], "reply")
    assert.equal(invalid.calls[0][1].flags, MessageFlags.Ephemeral)
    assert.equal(alice.from, "2026-09-01")
})

test("old weekly buttons preserve their exact dates and still work after a restart", async () => {
    const dashboard = new Dashboard(clientFixture())
    const queries = useRows(dashboard)
    const week = interactionFixture({ customId: "sugd:week:2026-09-07:2026-09-13" })
    await dashboard.handle(week)
    assert.equal(week.calls[0][1].flags, MessageFlags.Ephemeral)
    assert.equal(queries[0].from, "2026-09-07")
    assert.equal(queries[0].to, "2026-09-13")
})

test("weekly posts deduplicate after restart and recover a send before database save failure", async t => {
    const client = clientFixture()
    let sent = 0
    let record
    let failSave = false
    const messages = new Collection()
    const channel = Object.create(TextChannel.prototype)
    Object.defineProperties(channel, {
        id: { value: "dashboard" },
        guild: { value: { id: "staff" } },
        permissionsFor: {
            value: () => new PermissionsBitField(PermissionFlagsBits.Administrator)
        },
        messages: {
            value: {
                async fetch(input) {
                    if (typeof input === "object") return messages
                    if (messages.has(input)) return messages.get(input)
                    throw Object.assign(new Error("Unknown message"), { code: 10008 })
                }
            }
        },
        send: {
            value: async payload => {
                sent++
                const message = {
                    id: String(sent),
                    author: { id: "bot" },
                    url: `https://discord.com/channels/staff/dashboard/${sent}`,
                    embeds: payload.embeds.map(embed => embed.toJSON())
                }
                messages.set(message.id, message)
                return message
            }
        }
    })
    client.channels.fetch = async () => channel
    const oldFind = DashboardPost.findOne
    const oldRepository = DashboardPost.getRepository
    t.after(() => {
        DashboardPost.findOne = oldFind
        DashboardPost.getRepository = oldRepository
    })
    DashboardPost.findOne = async () => record
    DashboardPost.getRepository = () => ({
        save: async value => {
            if (failSave) throw new Error("Offline DB")
            record = value
            return value
        }
    })
    const first = new Dashboard(client)
    useRows(first)
    await first.publish()
    assert.equal(sent, 1)
    const restarted = new Dashboard(client)
    useRows(restarted)
    await restarted.publish()
    assert.equal(sent, 1)
    record = undefined
    await restarted.publish()
    assert.equal(sent, 1)
    assert.ok(record)
    messages.clear()
    record = undefined
    failSave = true
    await assert.rejects(() => restarted.publish())
    assert.equal(sent, 2)
    failSave = false
    await restarted.publish()
    assert.equal(sent, 2)
    client.config.suggestionDashboard.channelId = ""
    client.config.suggestionDashboard.channelName = "suggestions"
    client.guilds = {
        fetch: async () => ({ channels: { fetch: async () => new Collection() } })
    }
    await assert.rejects(() => restarted.publish(), /exactly one/)
})

test("Monday schedule uses configured timezone and reconnect replaces the timer", async t => {
    const dashboard = new Dashboard(clientFixture())
    let calls = 0
    dashboard.publish = async () => {
        calls++
        return null
    }
    t.after(() => dashboard.job?.stop())
    await dashboard.start()
    const first = dashboard.job
    assert.equal(
        first.next(new Date("2026-09-20T12:00:00Z")).toISOString(),
        "2026-09-21T07:00:00.000Z"
    )
    assert.equal(
        first.next(new Date("2026-10-25T12:00:00Z")).toISOString(),
        "2026-10-26T08:00:00.000Z"
    )
    await dashboard.start()
    assert.equal(first.running(), false)
    assert.equal(calls, 2)
})
