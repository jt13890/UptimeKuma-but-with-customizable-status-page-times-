exports.up = async (knex) => {
    await knex.schema.alterTable("monitor", (table) => {
        table.boolean("degraded_by_others").notNullable().defaultTo(false);
        // JSON array of monitor IDs. Empty = all other monitors
        table.text("degraded_depends_on").notNullable().defaultTo("[]");
    });
};

exports.down = async (knex) => {
    await knex.schema.alterTable("monitor", (table) => {
        table.dropColumn("degraded_by_others");
        table.dropColumn("degraded_depends_on");
    });
};
