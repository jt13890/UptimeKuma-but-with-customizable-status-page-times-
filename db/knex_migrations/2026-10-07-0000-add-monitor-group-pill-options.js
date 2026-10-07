// Per-monitor status page display options, stored on monitor_group
// - pill_mode: "global" (follow the status page's "Show Only Last Heartbeat" switch), "status" (last status) or "uptime" (overall percentage)
// - show_pill: false hides the pill entirely for this monitor
exports.up = async (knex) => {
    await knex.schema.alterTable("monitor_group", (table) => {
        table.string("pill_mode", 10).notNullable().defaultTo("global");
        table.boolean("show_pill").notNullable().defaultTo(true);
    });
};

exports.down = async (knex) => {
    await knex.schema.alterTable("monitor_group", (table) => {
        table.dropColumn("pill_mode");
        table.dropColumn("show_pill");
    });
};
