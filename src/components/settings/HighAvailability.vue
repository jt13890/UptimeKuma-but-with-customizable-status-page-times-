<template>
    <div>
        <div v-if="dbType && dbType !== 'sqlite'" class="alert alert-info my-4">
            {{ $t("haNotSqlite") }}
        </div>

        <template v-else>
            <!-- Live status -->
            <div v-if="status && status.running && status.detail" class="my-4">
                <h5 class="settings-subheading">{{ $t("haStatus") }}</h5>
                <div class="shadow-box big-padding">
                    <div class="d-flex flex-wrap align-items-center gap-2 mb-3">
                        <span class="badge" :class="status.detail.role === 'active' ? 'bg-primary' : 'bg-secondary'">
                            {{ status.detail.role === "active" ? $t("haActive") : $t("haStandby") }}
                        </span>
                        <span class="badge" :class="status.detail.internetOk ? 'bg-success' : 'bg-danger'">
                            {{ status.detail.internetOk ? $t("haOnline") : $t("haOffline") }}
                        </span>
                        <span v-if="status.detail.preferred" class="badge bg-info">{{ $t("haMainNode") }}</span>
                        <span class="text-muted ms-1">{{ status.detail.name }} · epoch {{ status.detail.epoch }}</span>
                    </div>

                    <div v-if="status.detail.lastSyncError" class="alert alert-warning">
                        {{ $t("haSyncError") }}: {{ status.detail.lastSyncError }}
                    </div>
                    <div v-if="!status.detail.eligible" class="alert alert-info">
                        {{ $t("haNotSyncedYet") }}
                    </div>

                    <table class="table mb-0">
                        <thead>
                            <tr>
                                <th>{{ $t("haOtherNode") }}</th>
                                <th>{{ $t("Status") }}</th>
                                <th>{{ $t("haLastContact") }}</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="peer in status.detail.peers" :key="peer.url">
                                <td>
                                    {{ peer.name || peer.url }}
                                    <div class="form-text">{{ peer.url }}</div>
                                </td>
                                <td>
                                    <span
                                        v-if="peer.reachable"
                                        class="badge"
                                        :class="peer.role === 'active' ? 'bg-primary' : 'bg-secondary'"
                                    >
                                        {{ peer.role === "active" ? $t("haActive") : $t("haStandby") }}
                                    </span>
                                    <span v-else class="badge bg-danger">{{ $t("haUnreachable") }}</span>
                                    <div v-if="peer.versionMismatch" class="text-danger small">
                                        {{ $t("haVersionMismatch", [peer.version]) }}
                                    </div>
                                    <div v-else-if="peer.lastError" class="text-danger small">{{ peer.lastError }}</div>
                                </td>
                                <td>{{ peer.lastSeen ? new Date(peer.lastSeen).toLocaleTimeString() : "-" }}</td>
                            </tr>
                        </tbody>
                    </table>
                    <div v-if="status.detail.appliedAt" class="form-text mt-2">
                        {{ $t("haLastSnapshot") }}: {{ new Date(status.detail.appliedAt).toLocaleString() }}
                    </div>
                </div>
            </div>

            <div v-if="restartRequired" class="alert alert-warning my-4">
                {{ $t("haRestartRequired") }}
            </div>

            <!-- Settings -->
            <form v-if="form" class="my-4" @submit.prevent="save">
                <h5 class="settings-subheading">{{ $t("haThisNode") }}</h5>

                <div class="form-check form-switch my-3">
                    <input id="ha-enabled" v-model="form.enabled" class="form-check-input" type="checkbox" />
                    <label class="form-check-label" for="ha-enabled">{{ $t("haEnable") }}</label>
                </div>

                <div class="my-3">
                    <label for="ha-name" class="form-label">{{ $t("haNodeName") }}</label>
                    <input
                        id="ha-name"
                        v-model="form.nodeName"
                        type="text"
                        class="form-control"
                        maxlength="60"
                        :placeholder="$t('haNodeNamePlaceholder')"
                    />
                </div>

                <div class="form-check form-switch my-3">
                    <input id="ha-preferred" v-model="form.preferred" class="form-check-input" type="checkbox" />
                    <label class="form-check-label" for="ha-preferred">{{ $t("haPreferred") }}</label>
                    <div class="form-text">{{ $t("haPreferredHelp") }}</div>
                </div>

                <div class="my-3">
                    <label for="ha-self" class="form-label">{{ $t("haSelfUrl") }}</label>
                    <input
                        id="ha-self"
                        v-model="form.selfUrl"
                        type="url"
                        class="form-control"
                        placeholder="https://kuma-home.example.com"
                    />
                    <div class="form-text">{{ $t("haSelfUrlHelp") }}</div>
                </div>

                <div class="my-3">
                    <label for="ha-peers" class="form-label">{{ $t("haPeerUrls") }}</label>
                    <textarea
                        id="ha-peers"
                        v-model="peersText"
                        class="form-control"
                        rows="2"
                        placeholder="https://kuma-vps.example.com"
                    ></textarea>
                    <div class="form-text">{{ $t("haPeerUrlsHelp") }}</div>
                    <div v-if="insecurePeer" class="text-warning small mt-1">{{ $t("haInsecureWarning") }}</div>
                </div>

                <div class="my-3">
                    <label for="ha-secret" class="form-label">{{ $t("haSecret") }}</label>
                    <div class="input-group">
                        <input
                            id="ha-secret"
                            v-model="form.secret"
                            type="password"
                            class="form-control"
                            autocomplete="new-password"
                            :placeholder="form.hasSecret ? $t('haSecretKeep') : ''"
                        />
                        <button
                            class="btn btn-outline-secondary"
                            type="button"
                            @click="
                                form.generateSecret = true;
                                form.secret = '';
                            "
                        >
                            {{ $t("haGenerateSecret") }}
                        </button>
                    </div>
                    <div v-if="form.generateSecret" class="form-text">{{ $t("haSecretWillBeGenerated") }}</div>
                    <div v-else class="form-text">{{ $t("haSecretHelp") }}</div>
                </div>

                <h5 class="settings-subheading mt-4">{{ $t("haBehaviour") }}</h5>

                <div class="row">
                    <div class="col-md-6 my-3">
                        <label for="ha-failover" class="form-label">{{ $t("haFailoverAfter") }}</label>
                        <input
                            id="ha-failover"
                            v-model.number="form.failoverAfterSec"
                            type="number"
                            min="5"
                            max="3600"
                            class="form-control"
                        />
                        <div class="form-text">{{ $t("haFailoverAfterHelp") }}</div>
                    </div>
                    <div class="col-md-6 my-3">
                        <label for="ha-stagger" class="form-label">{{ $t("haStagger") }}</label>
                        <input
                            id="ha-stagger"
                            v-model.number="form.staggerSec"
                            type="number"
                            min="0"
                            max="600"
                            class="form-control"
                        />
                        <div class="form-text">{{ $t("haStaggerHelp") }}</div>
                    </div>
                    <div class="col-md-6 my-3">
                        <label for="ha-snapshot" class="form-label">{{ $t("haSnapshotInterval") }}</label>
                        <input
                            id="ha-snapshot"
                            v-model.number="form.snapshotIntervalSec"
                            type="number"
                            min="5"
                            max="3600"
                            class="form-control"
                        />
                        <div class="form-text">{{ $t("haSnapshotIntervalHelp") }}</div>
                    </div>
                    <div class="col-md-6 my-3">
                        <label for="ha-isolation" class="form-label">{{ $t("haIsolationGrace") }}</label>
                        <input
                            id="ha-isolation"
                            v-model.number="form.isolationGraceSec"
                            type="number"
                            min="0"
                            max="3600"
                            class="form-control"
                        />
                        <div class="form-text">{{ $t("haIsolationGraceHelp") }}</div>
                    </div>
                </div>

                <div class="form-check form-switch my-3">
                    <input id="ha-failback" v-model="form.autoFailback" class="form-check-input" type="checkbox" />
                    <label class="form-check-label" for="ha-failback">{{ $t("haAutoFailback") }}</label>
                    <div class="form-text">{{ $t("haAutoFailbackHelp") }}</div>
                </div>

                <div v-if="form.autoFailback" class="my-3">
                    <label for="ha-failback-after" class="form-label">{{ $t("haFailbackAfter") }}</label>
                    <input
                        id="ha-failback-after"
                        v-model.number="form.failbackAfterSec"
                        type="number"
                        min="0"
                        max="86400"
                        class="form-control"
                    />
                </div>

                <div class="form-check form-switch my-3">
                    <input id="ha-observe" v-model="form.observe" class="form-check-input" type="checkbox" />
                    <label class="form-check-label" for="ha-observe">{{ $t("haObserve") }}</label>
                    <div class="form-text">{{ $t("haObserveHelp") }}</div>
                </div>

                <div class="my-3">
                    <label for="ha-targets" class="form-label">{{ $t("haConnectivityTargets") }}</label>
                    <textarea
                        id="ha-targets"
                        v-model="targetsText"
                        class="form-control"
                        rows="2"
                        placeholder="1.1.1.1:443"
                    ></textarea>
                    <div class="form-text">{{ $t("haConnectivityTargetsHelp") }}</div>
                </div>

                <div class="my-4">
                    <button class="btn btn-primary" type="submit" :disabled="saving">
                        <div v-if="saving" class="spinner-border spinner-border-sm me-1"></div>
                        {{ $t("Save") }}
                    </button>
                </div>
            </form>

            <!-- Join token -->
            <div v-if="form && form.enabled && configured" class="my-4 pt-3">
                <h5 class="settings-subheading">{{ $t("haAddSecondNode") }}</h5>
                <p>{{ $t("haAddSecondNodeHelp") }}</p>
                <button class="btn btn-outline-primary mb-3" type="button" @click="createToken">
                    {{ $t("haCreateToken") }}
                </button>
                <div v-if="token">
                    <textarea
                        class="form-control font-monospace"
                        rows="4"
                        readonly
                        :value="token"
                        @focus="$event.target.select()"
                    ></textarea>
                    <div class="form-text my-2">{{ $t("haTokenWarning") }}</div>
                    <pre
                        class="bg-dark text-light p-3 rounded"
                    ><code>docker run -d --restart=always -p 3001:3001 -v uptime-kuma:/app/data \
  -e UPTIME_KUMA_HA_JOIN="{{ token }}" \
  -e UPTIME_KUMA_HA_NODE_NAME="second-node" \
  -e UPTIME_KUMA_HA_URL="https://this-second-node.example.com" \
  --name uptime-kuma louislam/uptime-kuma:2</code></pre>
                </div>
            </div>
        </template>
    </div>
</template>

<script>
export default {
    data() {
        return {
            dbType: this.$root.info?.dbType || null,
            form: null,
            configured: false,
            peersText: "",
            targetsText: "",
            status: null,
            token: "",
            saving: false,
            restartRequired: false,
            timer: null,
        };
    },

    computed: {
        insecurePeer() {
            return this.peersText.split("\n").some((line) => {
                const url = line.trim();
                if (!url.startsWith("http://")) {
                    return false;
                }
                // Private networks and VPN addresses are fine, anything else is readable on the way
                return !/^http:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|[^/.]+(:\d+)?(\/|$))/.test(
                    url
                );
            });
        },
    },

    mounted() {
        this.load();
        this.refreshStatus();
        this.timer = setInterval(() => this.refreshStatus(), 5000);
    },

    beforeUnmount() {
        clearInterval(this.timer);
    },

    methods: {
        load() {
            this.$root.getSocket().emit("getHAConfig", (res) => {
                if (!res.ok) {
                    this.$root.toastRes(res);
                    return;
                }
                this.dbType = res.dbType;
                this.configured = res.configured;
                this.form = { ...res.config, secret: "", generateSecret: false };
                this.peersText = (res.config.peers || []).join("\n");
                this.targetsText = (res.config.connectivityTargets || []).join("\n");
                if (res.configured && res.config.enabled && !res.running) {
                    this.restartRequired = true;
                }
            });
        },

        refreshStatus() {
            this.$root.getSocket().emit("getHAStatus", (res) => {
                if (res.ok) {
                    this.status = res;
                }
            });
        },

        save() {
            const lines = (text) =>
                text
                    .split("\n")
                    .map((line) => line.trim())
                    .filter((line) => line !== "");

            this.saving = true;
            const payload = {
                ...this.form,
                peers: lines(this.peersText),
                connectivityTargets: lines(this.targetsText),
            };
            delete payload.hasSecret;

            this.$root.getSocket().emit("saveHAConfig", payload, (res) => {
                this.saving = false;
                this.$root.toastRes(res);
                if (res.ok) {
                    this.configured = true;
                    this.form = { ...res.config, secret: "", generateSecret: false };
                    this.restartRequired = !!res.restartRequired;
                    for (const result of res.push || []) {
                        if (!result.ok) {
                            this.$root.toastError(`${result.url}: ${result.msg}`);
                        }
                    }
                    this.refreshStatus();
                }
            });
        },

        createToken() {
            this.$root.getSocket().emit("generateHAJoinToken", (res) => {
                if (res.ok) {
                    this.token = res.token;
                } else {
                    this.$root.toastRes(res);
                }
            });
        },
    },
};
</script>
