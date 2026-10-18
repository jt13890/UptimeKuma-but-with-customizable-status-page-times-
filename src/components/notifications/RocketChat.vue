<template>
    <div class="mb-3">
        <label for="rocket-webhook-url" class="form-label">
            {{ $t("Webhook URL") }}
            <span style="color: red"><sup>*</sup></span>
        </label>
        <input
            id="rocket-webhook-url"
            v-model="$parent.notification.rocketwebhookURL"
            type="text"
            class="form-control"
            required
        />
        <label for="rocket-username" class="form-label">{{ $t("Username") }}</label>
        <input id="rocket-username" v-model="$parent.notification.rocketusername" type="text" class="form-control" />
        <label for="rocket-iconemo" class="form-label">{{ $t("Icon Emoji") }}</label>
        <input id="rocket-iconemo" v-model="$parent.notification.rocketiconemo" type="text" class="form-control" />
        <label for="rocket-channel" class="form-label">{{ $t("Channel Name") }}</label>
        <input id="rocket-channel-name" v-model="$parent.notification.rocketchannel" type="text" class="form-control" />
        <div class="form-text">
            <span style="color: red"><sup>*</sup></span>
            {{ $t("Required") }}
            <i18n-t tag="p" keypath="aboutWebhooks" style="margin-top: 8px">
                <a href="https://docs.rocket.chat/guides/administration/administration/integrations" target="_blank">
                    https://docs.rocket.chat/guides/administration/administration/integrations
                </a>
            </i18n-t>
            <p style="margin-top: 8px">
                {{ $t("aboutChannelName", ["rocket.chat"]) }}
            </p>
            <p style="margin-top: 8px">
                {{ $t("aboutKumaURL") }}
            </p>
            <i18n-t tag="p" keypath="emojiCheatSheet" style="margin-top: 8px">
                <a href="https://www.webfx.com/tools/emoji-cheat-sheet/" target="_blank">
                    https://www.webfx.com/tools/emoji-cheat-sheet/
                </a>
            </i18n-t>
        </div>
    </div>

    <div class="mb-3">
        <div class="form-check form-switch">
            <input
                id="rocket-notify-on-degraded"
                v-model="$parent.notification.rocketNotifyOnDegraded"
                class="form-check-input"
                type="checkbox"
            />
            <label class="form-check-label" for="rocket-notify-on-degraded">
                {{ $t("rocketNotifyOnDegradedTitle") }}
            </label>
        </div>
        <div class="form-text">{{ $t("rocketNotifyOnDegradedDesc") }}</div>
    </div>
</template>
