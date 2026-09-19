export const DASHBOARD_STATUSES: Record<string, string> = {
    "all": "All statuses",
    "open": "Unanswered",
    "in-progress": "In Progress",
    "approved": "Approved",
    "denied": "Rejected",
    "information": "More information needed",
    "forwarded": "Forwarded",
    "duplicate": "Duplicate",
    "invalid": "Invalid"
}

export interface DashboardFilters {
    query: string
    status: string
    source: "all" | "main" | "staff"
    from: string
    to: string
}

export function calendarDate(now: Date, timezone: string): string {
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).formatToParts(now)
    const part = (type: string) => parts.find(item => item.type === type)!.value
    return `${part("year")}-${part("month")}-${part("day")}`
}

export function validDate(value: string): boolean {
    const parsed = new Date(`${value}T00:00:00Z`)
    return (
        /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        value >= "2000-01-01" &&
        value <= "2100-12-31" &&
        !Number.isNaN(parsed.getTime()) &&
        parsed.toISOString().slice(0, 10) === value
    )
}

export function shiftDate(value: string, days: number): string {
    const date = new Date(`${value}T00:00:00Z`)
    date.setUTCDate(date.getUTCDate() + days)
    return date.toISOString().slice(0, 10)
}

export function validateTimezone(value: string): string {
    if (!value || value.length > 100 || (!value.includes("/") && value !== "UTC"))
        throw new Error(
            "Enter a timezone such as Europe/Amsterdam, America/New_York or UTC."
        )
    try {
        return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions()
            .timeZone
    } catch {
        throw new Error(
            "Unknown timezone. Try Europe/Amsterdam, America/New_York or UTC."
        )
    }
}

// Convert a calendar midnight to UTC, including daylight saving transitions.
export function midnight(value: string, timezone: string): Date {
    const target = new Date(`${value}T00:00:00Z`).getTime()
    let low = target - 48 * 60 * 60 * 1000
    let high = target + 48 * 60 * 60 * 1000
    const formatter = new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    })
    // Find the first instant of this local date, even when midnight is skipped
    // or repeated. A skipped date has an empty interval, ending at the next day.
    while (low < high) {
        const guess = Math.floor((low + high) / 2)
        const parts = formatter.formatToParts(new Date(guess))
        const part = (type: string) => parts.find(item => item.type === type)!.value
        const date = `${part("year")}-${part("month")}-${part("day")}`
        if (date < value) low = guess + 1
        else high = guess
    }
    return new Date(low)
}

export function previousWeek(now: Date, timezone: string) {
    const today = calendarDate(now, timezone)
    const weekday = new Date(`${today}T12:00:00Z`).getUTCDay()
    const monday = shiftDate(today, -((weekday + 6) % 7))
    return { from: shiftDate(monday, -7), to: shiftDate(monday, -1), monday }
}

export function validateFilters(filters: DashboardFilters): void {
    if (
        filters.query.length > 200 ||
        !Object.hasOwn(DASHBOARD_STATUSES, filters.status) ||
        !["all", "main", "staff"].includes(filters.source)
    )
        throw new Error("Invalid search filter.")
    for (const date of [filters.from, filters.to]) {
        if (date && !validDate(date))
            throw new Error("Enter a valid date as YYYY-MM-DD (2000–2100).")
    }
    if (filters.from && filters.to && filters.from > filters.to)
        throw new Error("The start date must be on or before the end date.")
}

export function filterSql(filters: DashboardFilters, timezone: string) {
    validateFilters(filters)
    const clauses = ["s.deleted_at IS NULL"]
    const params: Record<string, string | boolean | Date> = {}
    if (filters.query) {
        clauses.push(
            "(LOWER(s.title) LIKE :query ESCAPE '!' OR LOWER(s.body) LIKE :query ESCAPE '!')"
        )
        params.query = `%${filters.query
            .toLowerCase()
            .replace(/[!%_]/g, char => `!${char}`)}%`
    }
    if (filters.status === "open") {
        clauses.push("(s.status IS NULL OR s.status = '' OR s.status = 'open')")
    } else if (filters.status !== "all") {
        clauses.push("s.status = :status")
        params.status = filters.status
    }
    if (filters.source !== "all") {
        clauses.push("s.staff = :staff")
        params.staff = filters.source === "staff"
    }
    if (filters.from) {
        clauses.push("s.created_at >= :from")
        params.from = midnight(filters.from, timezone)
    }
    if (filters.to) {
        clauses.push("s.created_at < :until")
        params.until = midnight(shiftDate(filters.to, 1), timezone)
    }
    return { where: clauses.join(" AND "), params }
}

export function canReview(
    isStaffGuild: boolean,
    isAdministrator: boolean,
    memberRoles: string[],
    reviewerRoles: string[]
): boolean {
    return (
        isStaffGuild &&
        (isAdministrator || memberRoles.some(role => reviewerRoles.includes(role)))
    )
}
