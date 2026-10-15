// What each node last saw when it checked a monitor (high availability).
// A standby node runs the same checks as the active node but only reports the outcome here.
// The active node uses it for "up wins": it never declares a monitor DOWN while a peer recently saw it UP.
exports.up = async function (knex) {
    await knex.schema.createTable("ha_observation", function (table) {
        table.increments("id");
        table
            .integer("monitor_id")
            .unsigned()
            .notNullable()
            .references("id")
            .inTable("monitor")
            .onDelete("CASCADE")
            .onUpdate("CASCADE");
        table.string("node_id", 190).notNullable();
        table.smallint("status").notNullable();
        table.text("msg").nullable();
        table.integer("ping").nullable();
        // UTC, set by the database clock
        table.datetime("observed_at").notNullable();
        table.unique(["monitor_id", "node_id"]);
    });
};

exports.down = function (knex) {
    return knex.schema.dropTable("ha_observation");
};
