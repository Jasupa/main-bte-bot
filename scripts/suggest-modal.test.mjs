import "reflect-metadata"
import assert from "node:assert/strict"
import { test } from "node:test"
import { MessageFlags } from "discord.js"
import Suggestion from "../dist/entities/Suggestion.entity.js"
import createSuggestion from "../dist/modals/suggest.modal.js"

function fixture(body = "Test description") {
    const replies = []
    const errors = []
    const interaction = {
        customId: "suggestmodal.test",
        guild: { id: "staff" },
        channel: { id: "suggestions" },
        user: { id: "tester" },
        fields: {
            getTextInputValue: name => ({ title: "Test", body, teams: "Test" }[name])
        },
        async deferReply(options) {
            assert.equal(options.flags, MessageFlags.Ephemeral)
            assert.ok(!this.deferred)
            this.deferred = true
        },
        async editReply(payload) {
            assert.ok(this.deferred)
            replies.push(payload.content)
        },
        async reply() {
            assert.fail("Must edit the deferred reply")
        }
    }
    const client = {
        config: {
            guilds: { staff: "staff" },
            suggestions: { staff: "suggestions" },
            emojis: { upvote: "up", downvote: "down" }
        },
        interactionInfo: new Map([
            [
                interaction.customId,
                { modalType: "suggestmodal", anon: false, subsuggestion: "" }
            ]
        ]),
        messages: { getMessage: key => key },
        logger: { error: value => errors.push(value) },
        channels: { cache: new Map() }
    }
    return { interaction, client, replies, errors }
}

test("invalid suggestion stops before saving or sending a second response", async t => {
    const f = fixture("")
    t.mock.method(Suggestion, "findNumber", () =>
        assert.fail("Must not create invalid suggestion")
    )
    await createSuggestion(f.interaction, f.client)
    assert.deepEqual(f.replies, ["noBody"])
    assert.deepEqual(f.errors, [])
    assert.equal(f.client.interactionInfo.size, 0)
})

test("successful suggestion saves and edits its deferred acknowledgement", async t => {
    const f = fixture()
    let saved = 0
    const reactions = []
    t.mock.method(Suggestion, "findNumber", async () => 1)
    t.mock.method(Suggestion.prototype, "displayEmbed", async () => ({}))
    t.mock.method(Suggestion.prototype, "getIdentifier", async () => "1")
    t.mock.method(Suggestion.prototype, "save", async function () {
        saved++
        return this
    })
    const channel = {
        threads: {
            create: async () => ({ id: "thread", setRateLimitPerUser: async () => {} })
        }
    }
    channel.send = async () => ({
        id: "message",
        channel,
        react: async emoji => reactions.push(emoji)
    })
    f.client.channels.cache.set("suggestions", channel)
    await createSuggestion(f.interaction, f.client)
    assert.equal(saved, 1)
    assert.deepEqual(f.replies, ["Suggestion created!"])
    assert.deepEqual(reactions, ["up", "down"])
    assert.deepEqual(f.errors, [])
})

test("database failure is handled without an unhandled rejection", async t => {
    const f = fixture()
    t.mock.method(Suggestion, "findNumber", async () => {
        throw new Error("Database unavailable")
    })
    await assert.doesNotReject(createSuggestion(f.interaction, f.client))
    assert.equal(f.errors.length, 1)
    assert.match(f.replies[0], /Could not finish/)
    assert.equal(f.client.interactionInfo.size, 0)
})
