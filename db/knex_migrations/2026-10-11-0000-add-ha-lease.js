// Single-row lease table used for active/passive high availability.
// Exactly one node may hold the lease (row id = 1) at a time. The holder is the "active" node,
// every other node is a "standby" and does not run monitors/jobs.
exports.up = async function (knex) {
    await knex.schema.createTable("ha_lease", function (table) {
        table.integer("id").primary();
        table.string("holder", 255).nullable();
        // Incremented every time the lease changes hands (fencing token)
        table.integer("epoch").notNullable().defaultTo(0);
        // UTC, always compared against the database clock, never a node's own clock
        table.datetime("expires_at").notNullable();
    });

    await knex("ha_lease").insert({
        id: 1,
        holder: null,
        epoch: 0,
        expires_at: "1970-01-01 00:00:00",
    });
};

exports.down = function (knex) {
    return knex.schema.dropTable("ha_lease");
};
