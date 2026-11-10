// HAProxy monitor: pulls the state of a frontend / backend / server from a HAProxy agent
// (extra/haproxy-agent/haproxy_agent.py) running on the HAProxy node.
exports.up = async (knex) => {
    await knex.schema.alterTable("monitor", (table) => {
        table.string("haproxy_agent_url", 255).nullable();
        table.text("haproxy_agent_token").nullable();
        table.string("haproxy_proxy", 255).nullable();
        table.string("haproxy_server", 255).nullable();
        table.integer("haproxy_min_up_servers").notNullable().defaultTo(1);
    });
};

exports.down = async (knex) => {
    await knex.schema.alterTable("monitor", (table) => {
        table.dropColumn("haproxy_agent_url");
        table.dropColumn("haproxy_agent_token");
        table.dropColumn("haproxy_proxy");
        table.dropColumn("haproxy_server");
        table.dropColumn("haproxy_min_up_servers");
    });
};
