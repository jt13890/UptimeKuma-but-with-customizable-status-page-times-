<template>
    <div ref="modal" class="modal fade" tabindex="-1" data-testid="history-edit-dialog">
        <div class="modal-dialog">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title">{{ $t("historyEditTitle") }}</h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal" :aria-label="$t('Close')" />
                </div>

                <div class="modal-body">
                    <p class="text-muted">{{ $t("historyEditDescription") }}</p>

                    <div class="row g-2 mb-3">
                        <div class="col-12 col-sm-6">
                            <label for="history-from" class="form-label">{{ $t("historyEditFrom") }}</label>
                            <input
                                id="history-from"
                                v-model="from"
                                type="datetime-local"
                                class="form-control"
                                data-testid="history-from"
                                @change="onInput"
                            />
                        </div>
                        <div class="col-12 col-sm-6">
                            <label for="history-to" class="form-label">{{ $t("historyEditTo") }}</label>
                            <input
                                id="history-to"
                                v-model="to"
                                type="datetime-local"
                                class="form-control"
                                data-testid="history-to"
                                @change="onInput"
                            />
                        </div>
                        <div class="form-text">{{ $t("historyEditTimezone", { timezone }) }}</div>
                    </div>

                    <div class="mb-3">
                        <div class="form-label">{{ $t("historyEditStatus") }}</div>
                        <div class="btn-group" role="group">
                            <button
                                type="button"
                                class="btn"
                                :class="status === 'up' ? 'btn-primary' : 'btn-outline-secondary'"
                                data-testid="history-status-up"
                                @click="setStatus('up')"
                            >
                                {{ $t("historyEditSetUp") }}
                            </button>
                            <button
                                type="button"
                                class="btn"
                                :class="status === 'down' ? 'btn-danger' : 'btn-outline-secondary'"
                                data-testid="history-status-down"
                                @click="setStatus('down')"
                            >
                                {{ $t("historyEditSetDown") }}
                            </button>
                        </div>
                    </div>

                    <div v-if="error" class="alert alert-danger py-2" data-testid="history-error">{{ error }}</div>
                    <div v-else-if="summary" class="alert alert-info py-2" data-testid="history-preview">
                        {{
                            $t("historyEditPreview", {
                                changed: summary.changed,
                                inserted: summary.inserted,
                                unchanged: summary.unchanged,
                            })
                        }}
                    </div>

                    <div v-if="confirming" class="alert alert-warning py-2" data-testid="history-warning">
                        {{ $t("historyEditWarning") }}
                    </div>
                </div>

                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">
                        {{ $t("Cancel") }}
                    </button>
                    <button
                        type="button"
                        class="btn"
                        :class="confirming ? 'btn-danger' : 'btn-primary'"
                        :disabled="processing || !canApply"
                        data-testid="history-apply"
                        @click="apply"
                    >
                        <span v-if="processing" class="spinner-border spinner-border-sm me-1"></span>
                        {{ confirming ? $t("historyEditConfirm") : $t("historyEditApply") }}
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
import { Modal } from "bootstrap";

/**
 * Format a Date for <input type="datetime-local"> in the local timezone
 * @param {Date} date Date
 * @returns {string} YYYY-MM-DDTHH:mm
 */
function toLocalInput(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export default {
    props: {
        /** ID of the monitor */
        monitorId: {
            type: Number,
            required: true,
        },
    },

    emits: ["changed"],

    data() {
        return {
            modal: null,
            from: "",
            to: "",
            status: "down",
            summary: null,
            error: "",
            confirming: false,
            processing: false,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            previewTimer: null,
        };
    },

    computed: {
        canApply() {
            return !!this.summary && !this.error && this.summary.changed + this.summary.inserted > 0;
        },
    },

    mounted() {
        this.modal = new Modal(this.$refs.modal);
    },

    beforeUnmount() {
        clearTimeout(this.previewTimer);
        this.modal?.dispose();
    },

    methods: {
        /**
         * Open the dialog with the last hour selected
         * @returns {void}
         */
        show() {
            const now = new Date();
            now.setSeconds(0, 0);
            this.to = toLocalInput(now);
            this.from = toLocalInput(new Date(now.getTime() - 60 * 60 * 1000));
            this.status = "down";
            this.confirming = false;
            this.summary = null;
            this.error = "";
            this.modal.show();
            this.loadPreview();
        },

        /**
         * @param {"up"|"down"} status The status to set
         * @returns {void}
         */
        setStatus(status) {
            this.status = status;
            this.onInput();
        },

        /**
         * Something changed: ask the server again, after a short pause
         * @returns {void}
         */
        onInput() {
            this.confirming = false;
            clearTimeout(this.previewTimer);
            this.previewTimer = setTimeout(() => this.loadPreview(), 250);
        },

        /**
         * @returns {{from: number, to: number, status: string}} Request for the server, the times are in ms since epoch
         */
        request() {
            return {
                from: new Date(this.from).getTime(),
                to: new Date(this.to).getTime(),
                status: this.status,
            };
        },

        /**
         * Ask the server how many heartbeats would change
         * @returns {void}
         */
        loadPreview() {
            this.summary = null;
            this.error = "";

            if (!this.from || !this.to) {
                return;
            }

            this.$root.getSocket().emit("previewMonitorHistory", this.monitorId, this.request(), (res) => {
                if (res.ok) {
                    this.summary = res.summary;
                } else {
                    this.error = res.msg;
                }
            });
        },

        /**
         * First click asks for confirmation, the second one rewrites the history
         * @returns {void}
         */
        apply() {
            if (!this.confirming) {
                this.confirming = true;
                return;
            }

            this.processing = true;
            this.$root.getSocket().emit("editMonitorHistory", this.monitorId, this.request(), (res) => {
                this.processing = false;
                this.confirming = false;

                if (res.ok) {
                    this.$root.toastSuccess(
                        this.$t("historyEditDone", { changed: res.summary.changed, inserted: res.summary.inserted })
                    );
                    this.modal.hide();
                    this.$emit("changed");
                } else {
                    this.error = res.msg;
                }
            });
        },
    },
};
</script>
