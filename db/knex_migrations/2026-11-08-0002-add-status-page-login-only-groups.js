// Login-only groups on status pages
// - group.login_required: the group is only shown to authenticated viewers
// - status_page.forward_auth_header: name of the header a reverse proxy (forward auth) sets for logged-in users, e.g. "X-authentik-username"
// - status_page.forward_auth_trusted_proxies: IPs / CIDRs of the proxies the header is accepted from (comma or newline separated)
// - status_page.forward_auth_login_url: where the "log in" link on the status page goes (optional)
exports.up = async (knex) => {
    await knex.schema.alterTable("group", (table) => {
        table.boolean("login_required").notNullable().defaultTo(false);
    });

    await knex.schema.alterTable("status_page", (table) => {
        table.string("forward_auth_header", 100).nullable();
        table.text("forward_auth_trusted_proxies").nullable();
        table.string("forward_auth_login_url", 500).nullable();
    });
};

exports.down = async (knex) => {
    await knex.schema.alterTable("group", (table) => {
        table.dropColumn("login_required");
    });

    await knex.schema.alterTable("status_page", (table) => {
        table.dropColumn("forward_auth_header");
        table.dropColumn("forward_auth_trusted_proxies");
        table.dropColumn("forward_auth_login_url");
    });
};
