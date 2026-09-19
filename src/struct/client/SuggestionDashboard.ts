import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    Interaction,
    MessageFlags,
    ModalBuilder,
    PermissionFlagsBits,
    StringSelectMenuBuilder,
    TextChannel,
    TextInputBuilder,
    TextInputStyle,
    escapeMarkdown
} from "discord.js"
import { randomUUID } from "crypto"
import { Cron } from "croner"
import type BotClient from "../BotClient.js"
import Suggestion from "../../entities/Suggestion.entity.js"
import SuggestionDashboardPost from "../../entities/SuggestionDashboardPost.entity.js"
import SuggestionDashboardPreference from "../../entities/SuggestionDashboardPreference.entity.js"
import {
    DASHBOARD_STATUSES,
    DashboardFilters,
    calendarDate,
    canReview,
    filterSql,
    midnight,
    previousWeek,
    shiftDate,
    validateFilters,
    validateTimezone
} from "../../util/suggestionDashboard.util.js"

interface Session extends DashboardFilters {
    timezone: string
    timezoneSelected: boolean
    owner: string
    page: number
    expires: number
    period: string
    busy: boolean
}

const PAGE_SIZE = 5
const SESSION_TTL = 30 * 60 * 1000
const PREFIX = "sugd:"
const periods: Record<string, string> = {
    "all": "All dates",
    "week": "Previous calendar week",
    "7": "Last 7 days",
    "30": "Last 30 days",
    "90": "Last 90 days",
    "custom": "Custom date range"
}
const instances = new WeakMap<BotClient, SuggestionDashboard>()
const clip = (text: string, length: number) =>
    text.length > length ? `${text.slice(0, length - 1)}…` : text
const clean = (text: string, length: number) =>
    clip(escapeMarkdown(text).replace(/@/g, "@\u200b"), length)

export default class SuggestionDashboard {
    private sessions = new Map<string, Session>()
    private job?: Cron
    private publishing = false

    constructor(private client: BotClient) {}

    static for(client: BotClient): SuggestionDashboard {
        let dashboard = instances.get(client)
        if (!dashboard) {
            dashboard = new SuggestionDashboard(client)
            instances.set(client, dashboard)
        }
        return dashboard
    }

    private get timezone(): string {
        return this.client.config.suggestionDashboard?.timezone || "Europe/Amsterdam"
    }

    private allowed(interaction: Interaction, publish = false): boolean {
        const member = interaction.member
        const roles = member
            ? Array.isArray(member.roles)
                ? member.roles
                : [...member.roles.cache.keys()]
            : []
        const reviewers = [
            ...this.client.roles.ADMIN,
            ...this.client.roles.MANAGER,
            ...(publish
                ? []
                : this.client.config.suggestionDashboard?.reviewerRoleIds || [])
        ]
        return canReview(
            interaction.guildId === this.client.config.guilds.staff,
            interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
                false,
            roles,
            reviewers
        )
    }

    private availability(): string | null {
        const config = this.client.config.suggestionDashboard
        if (!config?.enabled || !(config.channelId || config.channelName))
            return "The suggestion dashboard is not configured yet. Ask an Admin to set it up."
        return null
    }

    async open(
        interaction: import("discord.js").ChatInputCommandInteraction,
        publish = false
    ): Promise<void> {
        const error = this.availability()
        if (error || !this.allowed(interaction, publish)) {
            await interaction.reply({
                content:
                    error ||
                    "Only Admins, Managers and configured reviewers in the Staff server can use this dashboard. Publishing is restricted to Admins and Managers.",
                flags: MessageFlags.Ephemeral
            })
            return
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral })
        try {
            if (publish) {
                const messageUrl = await this.publish()
                await interaction.editReply({
                    content: messageUrl
                        ? `The weekly menu is ready: ${messageUrl}`
                        : "The weekly update is already being processed. Please try again shortly."
                })
            } else {
                const [id, session] = await this.createSession(interaction.user.id)
                await interaction.editReply(await this.render(id, session))
            }
        } catch (error) {
            this.client.logger.error(`Suggestion dashboard: ${String(error)}`)
            await interaction.editReply({
                content:
                    "The dashboard could not be loaded. Ask an Admin to check the database and bot channel permissions.",
                embeds: [],
                components: []
            })
        }
    }

    private async createSession(owner: string): Promise<[string, Session]> {
        const preference = await SuggestionDashboardPreference.findOne({ userId: owner })
        this.prune()
        if (this.sessions.size >= 1000)
            this.sessions.delete(this.sessions.keys().next().value!)
        const id = randomUUID().slice(0, 12)
        const session: Session = {
            timezone: preference?.timezone || this.timezone,
            timezoneSelected: Boolean(preference),
            owner,
            page: 0,
            expires: Date.now() + SESSION_TTL,
            period: "all",
            query: "",
            status: "all",
            source: "all",
            from: "",
            to: "",
            busy: false
        }
        this.sessions.set(id, session)
        return [id, session]
    }

    private prune(): void {
        for (const [id, session] of this.sessions) {
            if (session.expires < Date.now()) this.sessions.delete(id)
        }
    }

    private setPeriod(session: Session, period: string): void {
        const today = calendarDate(new Date(), session.timezone)
        session.period = period
        session.from = ""
        session.to = ""
        if (period === "week")
            Object.assign(session, previousWeek(new Date(), session.timezone))
        if (["7", "30", "90"].includes(period)) {
            session.from = shiftDate(today, -(Number(period) - 1))
            session.to = today
        }
        session.page = 0
    }

    private search(filters: DashboardFilters & { timezone?: string }) {
        const { where, params } = filterSql(filters, filters.timezone || this.timezone)
        return Suggestion.getRepository()
            .createQueryBuilder("s")
            .where(where, params)
            .orderBy("s.created_at", "DESC")
            .addOrderBy("s.id", "DESC")
    }

    private async render(id: string, session: Session) {
        const query = this.search(session)
        const total = await query.getCount()
        const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
        session.page = Math.max(0, Math.min(pages - 1, session.page))
        const rows = await query
            .skip(session.page * PAGE_SIZE)
            .take(PAGE_SIZE)
            .getMany()
        const range =
            session.from || session.to
                ? `${session.from || "the beginning"} through ${
                      session.to || "no end date"
                  }`
                : "All dates"
        const embed = new EmbedBuilder()
            .setColor(0x728b62)
            .setTitle("Suggestion dashboard · Main & Staff")
            .setDescription(
                `**${total} suggestions** · ${
                    DASHBOARD_STATUSES[session.status]
                }\n${range} (${session.timezone})${
                    !session.timezoneSelected
                        ? "\nSet your timezone in Search / dates; currently using the server default."
                        : ""
                }${
                    session.query
                        ? `\nSearch: **${clean(session.query, 200)}**`
                        : "\nNewest suggestions first."
                }`
            )
            .setFooter({
                text: `Page ${
                    session.page + 1
                }/${pages} · Only visible to you · Session expires after 30 minutes of inactivity`
            })
        for (const suggestion of rows) {
            const number = suggestion.number ?? `${suggestion.extends} (follow-up)`
            const source = suggestion.staff ? "Staff" : "Main"
            const status =
                DASHBOARD_STATUSES[suggestion.status || "open"] || suggestion.status
            embed.addFields({
                name: clip(`${source} #${number} · ${clean(suggestion.title, 190)}`, 256),
                value: `${
                    clean(suggestion.body, 350) || "No description."
                }\n**${status}** · <t:${Math.floor(
                    suggestion.createdAt.getTime() / 1000
                )}:d> · [Open in Discord](${suggestion.getURL(this.client)})`
            })
        }
        if (!rows.length)
            embed.addFields({
                name: "No suggestions found",
                value: "Adjust your filters or select Reset. Deleted suggestions are not shown."
            })
        const select = (
            action: string,
            placeholder: string,
            options: Record<string, string>,
            selected: string
        ) =>
            new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`${PREFIX}${id}:${action}`)
                    .setPlaceholder(placeholder)
                    .addOptions(
                        Object.entries(options).map(([value, label]) => ({
                            label,
                            value,
                            default: value === selected
                        }))
                    )
            )
        const button = (
            action: string,
            label: string,
            disabled = false,
            style = ButtonStyle.Secondary
        ) =>
            new ButtonBuilder()
                .setCustomId(`${PREFIX}${id}:${action}`)
                .setLabel(label)
                .setStyle(style)
                .setDisabled(disabled)
        return {
            content: "",
            embeds: [embed],
            components: [
                select("status", "Filter by status", DASHBOARD_STATUSES, session.status),
                select("period", "Filter by date", periods, session.period),
                select(
                    "source",
                    "Filter by server",
                    { all: "Main + Staff", main: "Main only", staff: "Staff only" },
                    session.source
                ),
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                    button("previous", "← Previous", session.page === 0),
                    button("next", "Next →", session.page >= pages - 1),
                    button("search", "Search / dates", false, ButtonStyle.Primary),
                    button("reset", "Reset"),
                    button("refresh", "Refresh")
                )
            ],
            allowedMentions: { parse: [] as [] }
        }
    }

    private modal(id: string, session: Session) {
        const input = (
            name: string,
            label: string,
            value: string,
            length: number,
            placeholder: string
        ) =>
            new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder()
                    .setCustomId(name)
                    .setLabel(label)
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false)
                    .setMaxLength(length)
                    .setPlaceholder(placeholder)
                    .setValue(value)
            )
        return new ModalBuilder()
            .setCustomId(`${PREFIX}${id}:filters`)
            .setTitle("Search and filter suggestions")
            .addComponents(
                input(
                    "query",
                    "Search title and full description",
                    session.query,
                    200,
                    "Leave empty to browse all suggestions"
                ),
                input(
                    "from",
                    "From (inclusive, in your timezone)",
                    session.from,
                    10,
                    "YYYY-MM-DD, e.g. 2026-09-01"
                ),
                input(
                    "to",
                    "To (inclusive)",
                    session.to,
                    10,
                    "YYYY-MM-DD, leave empty for no end date"
                ),
                input(
                    "timezone",
                    "Your timezone (saved for future visits)",
                    session.timezone,
                    100,
                    "Europe/Amsterdam, America/New_York or UTC"
                )
            )
    }

    async handle(interaction: Interaction): Promise<boolean> {
        if (
            !(
                interaction.isButton() ||
                interaction.isStringSelectMenu() ||
                interaction.isModalSubmit()
            ) ||
            !interaction.customId.startsWith(PREFIX)
        )
            return false
        try {
            const error = this.availability()
            if (error || !this.allowed(interaction)) {
                await interaction.reply({
                    content: error || "You do not have access to this dashboard.",
                    flags: MessageFlags.Ephemeral
                })
                return true
            }
            this.prune()
            const [, id, action, end] = interaction.customId.split(":")
            if (interaction.isButton() && (id === "open" || id === "week")) {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral })
                const [key, session] = await this.createSession(interaction.user.id)
                if (id === "week") {
                    session.from = action
                    session.to = end
                    session.period = "custom"
                    validateFilters(session)
                }
                await interaction.editReply(await this.render(key, session))
                return true
            }
            const session = this.sessions.get(id)
            if (!session || session.owner !== interaction.user.id) {
                await interaction.reply({
                    content:
                        "This menu has expired, the bot has restarted, or the menu belongs to someone else. Open a new menu from the weekly post or /suggestion-dashboard.",
                    flags: MessageFlags.Ephemeral
                })
                return true
            }
            if (session.busy) {
                await interaction.reply({
                    content:
                        "Your previous selection is still being processed. Please try again shortly.",
                    flags: MessageFlags.Ephemeral
                })
                return true
            }
            session.expires = Date.now() + SESSION_TTL
            if (
                (interaction.isButton() && action === "search") ||
                (interaction.isStringSelectMenu() &&
                    action === "period" &&
                    interaction.values[0] === "custom")
            ) {
                await interaction.showModal(this.modal(id, session))
                return true
            }
            session.busy = true
            try {
                const next = { ...session }
                if (interaction.isModalSubmit()) {
                    if (action !== "filters") throw new Error("Invalid form.")
                    next.query = interaction.fields.getTextInputValue("query").trim()
                    next.from = interaction.fields.getTextInputValue("from").trim()
                    next.to = interaction.fields.getTextInputValue("to").trim()
                    next.period = next.from || next.to ? "custom" : "all"
                    next.page = 0
                    try {
                        validateFilters(next)
                        next.timezone = validateTimezone(
                            interaction.fields.getTextInputValue("timezone").trim() ||
                                session.timezone
                        )
                        if (
                            next.from === session.from &&
                            next.to === session.to &&
                            session.period !== "custom"
                        )
                            this.setPeriod(next, session.period)
                    } catch (error) {
                        await interaction.reply({
                            content: (error as Error).message,
                            flags: MessageFlags.Ephemeral
                        })
                        return true
                    }
                    if (interaction.isFromMessage()) await interaction.deferUpdate()
                    else await interaction.deferReply({ flags: MessageFlags.Ephemeral })
                    await SuggestionDashboardPreference.save(
                        Object.assign(new SuggestionDashboardPreference(), {
                            userId: session.owner,
                            timezone: next.timezone
                        })
                    )
                    next.timezoneSelected = true
                } else {
                    await interaction.deferUpdate()
                    if (interaction.isStringSelectMenu()) {
                        const value = interaction.values[0]
                        if (action === "status") next.status = value
                        else if (action === "source")
                            next.source = value as Session["source"]
                        else if (action === "period" && Object.hasOwn(periods, value))
                            this.setPeriod(next, value)
                        else throw new Error("Invalid filter.")
                        next.page = 0
                    } else if (action === "next") next.page++
                    else if (action === "previous") next.page--
                    else if (action === "reset")
                        Object.assign(next, {
                            query: "",
                            status: "all",
                            source: "all",
                            from: "",
                            to: "",
                            period: "all",
                            page: 0
                        })
                    else if (action !== "refresh") throw new Error("Invalid action.")
                }
                const payload = await this.render(id, next)
                await interaction.editReply(payload)
                Object.assign(session, next)
            } finally {
                session.busy = false
            }
        } catch (error) {
            this.client.logger.error(`Suggestion dashboard interaction: ${String(error)}`)
            const content =
                "Could not load suggestions. Try again or open /suggestion-dashboard."
            if (interaction.deferred || interaction.replied)
                await interaction
                    .followUp({ content, flags: MessageFlags.Ephemeral })
                    .catch(() => null)
            else
                await interaction
                    .reply({ content, flags: MessageFlags.Ephemeral })
                    .catch(() => null)
        }
        return true
    }

    async start(): Promise<void> {
        this.job?.stop()
        if (this.availability()) return
        // Validate the configured timezone before starting a timer.
        calendarDate(new Date(), this.timezone)
        const publish = async () => {
            try {
                await this.publish()
            } catch (error) {
                this.client.logger.error(
                    `Suggestion dashboard weekly post: ${String(error)}`
                )
            }
        }
        this.job = new Cron("0 9 * * 1", { timezone: this.timezone }, publish)
        await publish() // Catch up once after downtime; the database marker prevents duplicates.
    }

    async publish(): Promise<string | null> {
        if (this.publishing) return null
        this.publishing = true
        try {
            const config = this.client.config.suggestionDashboard!
            let channel
            if (config.channelId)
                channel = await this.client.channels.fetch(config.channelId)
            else {
                const guild = await this.client.guilds.fetch(
                    this.client.config.guilds.staff
                )
                const matches = (await guild.channels.fetch()).filter(
                    candidate =>
                        candidate instanceof TextChannel &&
                        candidate.name === config.channelName?.replace(/^#/, "")
                )
                if (matches.size !== 1)
                    throw new Error(
                        "The dashboard channel name must match exactly one Staff text channel; otherwise configure channelId."
                    )
                channel = matches.first()
            }
            if (
                !(channel instanceof TextChannel) ||
                channel.guild.id !== this.client.config.guilds.staff
            )
                throw new Error(
                    "Configure a text channel in the Staff guild for suggestionDashboard.channelId."
                )
            const permissions = channel.permissionsFor(this.client.user!)
            if (
                !permissions?.has([
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.EmbedLinks,
                    PermissionFlagsBits.ReadMessageHistory
                ])
            )
                throw new Error(
                    "Dashboard channel requires View Channel, Send Messages, Embed Links and Read Message History."
                )
            const now = new Date()
            let period = previousWeek(now, this.timezone)
            const scheduled = new Date(
                midnight(period.monday, this.timezone).getTime() + 9 * 3600000
            )
            if (now < scheduled)
                period = previousWeek(
                    new Date(now.getTime() - 7 * 86400000),
                    this.timezone
                )
            const key = `${channel.id}:${period.monday}`
            const marker = `suggestion-dashboard:${key}`
            const stored = await SuggestionDashboardPost.findOne({ key })
            if (stored) {
                try {
                    return (await channel.messages.fetch(stored.messageId)).url
                } catch (error) {
                    if ((error as { code?: number }).code !== 10008) throw error
                }
            }
            // Recover a sent-but-not-persisted message after a database error or crash.
            const recent = await channel.messages.fetch({ limit: 100 })
            const recovered = recent.find(
                message =>
                    message.author.id === this.client.user!.id &&
                    message.embeds.some(embed => embed.footer?.text === marker)
            )
            if (recovered) {
                await SuggestionDashboardPost.getRepository().save({
                    key,
                    messageId: recovered.id
                })
                return recovered.url
            }
            const filters = {
                query: "",
                status: "all",
                source: "all" as const,
                from: period.from,
                to: period.to
            }
            const total = await this.search(filters).getCount()
            const embed = new EmbedBuilder()
                .setColor(0x728b62)
                .setTitle("Suggestions · weekly overview")
                .setDescription(
                    `**${total} new suggestions** from Main and Staff\n${period.from} through ${period.to} (${this.timezone})\n\nOpen the weekly overview or search all suggestions. Your menu and search results are only visible to you.\n\nAccess: Admins, Managers and configured reviewers.`
                )
                .setFooter({ text: marker })
            const message = await channel.send({
                embeds: [embed],
                allowedMentions: { parse: [] },
                components: [
                    new ActionRowBuilder<ButtonBuilder>().addComponents(
                        new ButtonBuilder()
                            .setCustomId(`${PREFIX}week:${period.from}:${period.to}`)
                            .setLabel("Browse previous week")
                            .setStyle(ButtonStyle.Primary),
                        new ButtonBuilder()
                            .setCustomId(`${PREFIX}open`)
                            .setLabel("All suggestions / search")
                            .setStyle(ButtonStyle.Secondary)
                    )
                ]
            })
            await SuggestionDashboardPost.getRepository().save({
                key,
                messageId: message.id
            })
            return message.url
        } finally {
            this.publishing = false
        }
    }
}
