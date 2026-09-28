exports.up = async function (knex) {
    // How many days of history a status page viewer can see.
    // 0 = legacy behaviour (last 100 heartbeats + 24h uptime)
    await knex.schema.alterTable("status_page", function (table) {
        table.integer("heartbeat_bar_days").notNullable().defaultTo(0);
    });
};

exports.down = function (knex) {
    return knex.schema.alterTable("status_page", function (table) {
        table.dropColumn("heartbeat_bar_days");
    });
};
