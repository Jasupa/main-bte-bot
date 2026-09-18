import Command from "../struct/Command.js"
import SuggestionDashboard from "../struct/client/SuggestionDashboard.js"

export default new Command({
    name: "suggestion-dashboard",
    aliases: [],
    description: "Browse and search Main and Staff suggestions privately.",
    // The dashboard enforces fresh Staff-guild role checks itself, including custom reviewers.
    permission: globalThis.client.roles.ANY,
    args: [
        {
            name: "publish",
            description:
                "Post or find this week's menu in the configured Staff channel (Admins/Managers).",
            required: false,
            optionType: "BOOLEAN"
        }
    ],
    async run(client, message, args) {
        await SuggestionDashboard.for(client).open(
            message.message,
            args.consumeBoolean("publish")
        )
    }
})
