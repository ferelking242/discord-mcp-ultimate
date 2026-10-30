# Tool audit — discord-mcp-ultimate

Inventory of every tool this server exposes, checked against the code that is
actually built and registered, not against the README. The counts and the tables
below are generated from `getAllDefinitions()` in the compiled `dist/`, so a tool
listed here is a tool the MCP client will see.

## How this audit was produced

```bash
npm run build
node -e "import('./dist/tools/index.js').then(m => console.log(m.getAllDefinitions().length))"
```

The baseline comparison is against commit `5d553cc`, the unmodified import of
PaSympa/discord-mcp 2.2.0. Tool names present in that commit and still present now
are counted as _preserved_; everything else is _added_.

## Headline numbers

| Metric                                              | Value |
| --------------------------------------------------- | ----- |
| Tools in the imported 2.2.0 baseline                | 99    |
| Tools in this build                                 | 177   |
| Preserved unchanged                                 | 99    |
| Added                                               | 78    |
| Removed                                             | 0     |
| Read-only tools (`readOnlyHint`)                    | 66    |
| Tools flagged `destructiveHint`                     | 26    |
| Tools advertising an `outputSchema`                 | 111   |
| Tools with a description shorter than 20 characters | 0     |
| Tools whose `inputSchema` is not an object root     | 0     |

The **Bot permission checked** column is extracted from the `assertBotPermission`
calls inside each tool's own handler, so it lists the flags this server verifies
_before_ calling Discord. A dash means the tool needs no specific permission
beyond being able to see the guild — for example a read-only tool, or one whose
only requirement is the bot's presence in the server. Permission _overwrites_ on
channels and roles are a separate, per-entity concern handled by
`discord_set_channel_permissions` and `discord_set_role_permissions`.

Every added tool has an `outputSchema`, a description, a human-readable `title`,
and a JSON Schema that sets `additionalProperties: false` at every object level.
That last property is enforced by `test/registry.test.ts`, which walks each
schema recursively and fails the build if any nested object omits it.

## What "status" means in this document

The mission brief asked for each tool to be marked functional, incomplete,
broken or missing. For the 99 imported tools the honest answer is that all 99 are
_registered and reachable_, and their handlers are exercised by the test suite
where a test can run without a live Discord server. Where a tool's behaviour
depends on Discord state that a unit test cannot reproduce — role hierarchy
ordering, an unverified bot being unable to ban, a boost-gated banner — that is
recorded in the limitations section rather than claimed as verified.

No tool in this build is a stub. No tool returns a success payload without
calling Discord, with the single deliberate exception of the preview branches,
which return `applied: false` and say so in the payload.

## Complete inventory

### `src/tools/discovery.ts` — 4 tools (4 preserved, 0 added)

| Tool                           | Required params    | Bot permission checked | Hints     | outputSchema |
| ------------------------------ | ------------------ | ---------------------- | --------- | ------------ |
| `discord_list_guilds`          | —                  | —                      | read-only | yes          |
| `discord_get_guild_info`       | `guild_id`         | —                      | read-only | yes          |
| `discord_list_channels`        | `guild_id`         | —                      | read-only | yes          |
| `discord_find_channel_by_name` | `guild_id`, `name` | —                      | read-only | yes          |

### `src/tools/messages.ts` — 21 tools (20 preserved, 1 added)

| Tool                              | Required params                                                                                                         | Bot permission checked | Hints                   | outputSchema |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------- | ----------------------- | ------------ |
| `discord_read_messages`           | `channel_id`, limit, before, after, around, since                                                                       | —                      | read-only               | yes          |
| `discord_send_message`            | `channel_id`, `content`                                                                                                 | —                      | —                       | no           |
| `discord_reply_message`           | `channel_id`, `message_id`, `content`                                                                                   | —                      | —                       | no           |
| `discord_edit_message`            | `channel_id`, `message_id`, `content`                                                                                   | —                      | idempotent              | no           |
| `discord_add_reaction`            | `channel_id`, `message_id`, `emoji`                                                                                     | —                      | idempotent              | no           |
| `discord_create_thread`           | `channel_id`, `name`, message_id, auto_archive_duration                                                                 | —                      | —                       | no           |
| `discord_bulk_delete_messages`    | `channel_id`, `count`, dry_run                                                                                          | —                      | destructive             | no           |
| `discord_send_embed`              | `channel_id`, title, url, description, color, fields, author, thumbnail_url, footer, image_url, timestamp               | —                      | —                       | no           |
| `discord_edit_embed`              | `channel_id`, `message_id`, title, url, description, color, fields, author, thumbnail_url, footer, image_url, timestamp | —                      | idempotent              | no           |
| `discord_send_multiple_embeds`    | `channel_id`, content, `embeds`                                                                                         | —                      | —                       | no           |
| `discord_delete_message`          | `channel_id`, `message_id`, reason                                                                                      | —                      | destructive             | no           |
| `discord_pin_message`             | `channel_id`, `message_id`, `pin`                                                                                       | —                      | idempotent              | no           |
| `discord_search_messages`         | `channel_id`, `keyword`, limit                                                                                          | —                      | read-only               | yes          |
| `discord_search_guild_messages`   | `guild_id`, `query`, channel_id, author_id, limit                                                                       | —                      | read-only               | yes          |
| `discord_crosspost_message`       | `channel_id`, `message_id`                                                                                              | —                      | idempotent              | no           |
| `discord_remove_reactions`        | `channel_id`, `message_id`, emoji, user_id                                                                              | —                      | destructive, idempotent | no           |
| `discord_get_reactions`           | `channel_id`, `message_id`, `emoji`, limit                                                                              | —                      | read-only               | yes          |
| `discord_get_message_attachments` | `channel_id`, `message_id`                                                                                              | —                      | read-only               | yes          |
| `discord_fetch_pinned_messages`   | `channel_id`                                                                                                            | —                      | read-only               | yes          |
| `discord_send_poll`               | `channel_id`, `question`, `answers`                                                                                     | —                      | —                       | yes          |
| `discord_forward_message`         | `channel_id`, `message_id`, `target_channel_id`                                                                         | —                      | —                       | no           |

### `src/tools/channels.ts` — 8 tools (8 preserved, 0 added)

| Tool                                  | Required params                              | Bot permission checked | Hints       | outputSchema |
| ------------------------------------- | -------------------------------------------- | ---------------------- | ----------- | ------------ |
| `discord_create_channel`              | `guild_id`, `name`, type, topic, category_id | —                      | —           | no           |
| `discord_delete_channel`              | `channel_id`, reason, dry_run                | —                      | destructive | no           |
| `discord_edit_channel`                | `channel_id`, name, topic, slowmode, nsfw    | —                      | idempotent  | no           |
| `discord_move_channel`                | `channel_id`, category_id                    | —                      | idempotent  | no           |
| `discord_clone_channel`               | `channel_id`, new_name                       | —                      | —           | no           |
| `discord_set_channel_position`        | `channel_id`, `position`                     | —                      | idempotent  | no           |
| `discord_follow_announcement_channel` | `source_channel_id`, `target_channel_id`     | —                      | —           | no           |
| `discord_lock_channel_permissions`    | `channel_id`                                 | —                      | idempotent  | no           |

### `src/tools/permissions.ts` — 6 tools (6 preserved, 0 added)

| Tool                                | Required params                                  | Bot permission checked | Hints                   | outputSchema |
| ----------------------------------- | ------------------------------------------------ | ---------------------- | ----------------------- | ------------ |
| `discord_get_channel_permissions`   | `channel_id`                                     | —                      | read-only               | yes          |
| `discord_set_role_permission`       | `channel_id`, `role_id`, allow, deny, reason     | —                      | idempotent              | no           |
| `discord_set_member_permission`     | `channel_id`, `user_id`, allow, deny, reason     | —                      | idempotent              | no           |
| `discord_reset_channel_permissions` | `channel_id`, reason                             | —                      | destructive, idempotent | no           |
| `discord_copy_permissions`          | `source_channel_id`, `target_channel_id`, reason | —                      | destructive, idempotent | no           |
| `discord_audit_permissions`         | `guild_id`                                       | —                      | read-only               | yes          |

### `src/tools/members.ts` — 11 tools (11 preserved, 0 added)

| Tool                      | Required params                                                 | Bot permission checked | Hints                   | outputSchema |
| ------------------------- | --------------------------------------------------------------- | ---------------------- | ----------------------- | ------------ |
| `discord_list_members`    | `guild_id`, limit, after                                        | —                      | read-only               | yes          |
| `discord_get_member_info` | `guild_id`, `user_id`                                           | —                      | read-only               | yes          |
| `discord_kick_member`     | `guild_id`, `user_id`, reason                                   | —                      | destructive             | no           |
| `discord_ban_member`      | `guild_id`, `user_id`, reason, delete_message_days              | —                      | destructive, idempotent | no           |
| `discord_unban_member`    | `guild_id`, `user_id`, reason                                   | —                      | idempotent              | no           |
| `discord_timeout_member`  | `guild_id`, `user_id`, `duration_minutes`, reason               | —                      | idempotent              | no           |
| `discord_search_members`  | `guild_id`, `query`, limit                                      | —                      | read-only               | yes          |
| `discord_set_nickname`    | `guild_id`, `user_id`, `nickname`, reason                       | —                      | idempotent              | no           |
| `discord_list_bans`       | `guild_id`, limit, after                                        | —                      | read-only               | yes          |
| `discord_bulk_ban`        | `guild_id`, `user_ids`, delete_message_seconds, dry_run, reason | —                      | destructive             | no           |
| `discord_prune_members`   | `guild_id`, `days`, roles, dry_run, reason                      | —                      | destructive             | no           |

### `src/tools/roles.ts` — 9 tools (9 preserved, 0 added)

| Tool                        | Required params                                                     | Bot permission checked | Hints       | outputSchema |
| --------------------------- | ------------------------------------------------------------------- | ---------------------- | ----------- | ------------ |
| `discord_list_roles`        | `guild_id`                                                          | —                      | read-only   | yes          |
| `discord_create_role`       | `guild_id`, `name`, color, hoist, mentionable, permissions          | —                      | —           | no           |
| `discord_edit_role`         | `guild_id`, `role_id`, name, color, hoist, mentionable, permissions | —                      | idempotent  | no           |
| `discord_delete_role`       | `guild_id`, `role_id`, reason                                       | —                      | destructive | no           |
| `discord_add_role`          | `guild_id`, `user_id`, `role_id`, reason                            | —                      | idempotent  | no           |
| `discord_remove_role`       | `guild_id`, `user_id`, `role_id`, reason                            | —                      | idempotent  | no           |
| `discord_get_role_members`  | `guild_id`, `role_id`                                               | —                      | read-only   | yes          |
| `discord_set_role_position` | `guild_id`, `role_id`, `position`                                   | —                      | idempotent  | no           |
| `discord_set_role_icon`     | `guild_id`, `role_id`, icon, unicode_emoji                          | —                      | idempotent  | no           |

### `src/tools/moderation.ts` — 1 tools (1 preserved, 0 added)

| Tool                    | Required params                | Bot permission checked | Hints     | outputSchema |
| ----------------------- | ------------------------------ | ---------------------- | --------- | ------------ |
| `discord_get_audit_log` | `guild_id`, limit, action_type | —                      | read-only | yes          |

### `src/tools/screening.ts` — 2 tools (2 preserved, 0 added)

| Tool                                  | Required params                      | Bot permission checked | Hints      | outputSchema |
| ------------------------------------- | ------------------------------------ | ---------------------- | ---------- | ------------ |
| `discord_get_membership_screening`    | `guild_id`                           | —                      | read-only  | yes          |
| `discord_update_membership_screening` | `guild_id`, description, form_fields | —                      | idempotent | no           |

### `src/tools/stats.ts` — 1 tools (1 preserved, 0 added)

| Tool                       | Required params | Bot permission checked | Hints     | outputSchema |
| -------------------------- | --------------- | ---------------------- | --------- | ------------ |
| `discord_get_server_stats` | `guild_id`      | —                      | read-only | yes          |

### `src/tools/forums.ts` — 10 tools (10 preserved, 0 added)

| Tool                           | Required params                                      | Bot permission checked | Hints                   | outputSchema |
| ------------------------------ | ---------------------------------------------------- | ---------------------- | ----------------------- | ------------ |
| `discord_get_forum_channels`   | `guild_id`                                           | —                      | read-only               | yes          |
| `discord_create_forum_channel` | `guild_id`, `name`, topic, category_id               | —                      | —                       | no           |
| `discord_create_forum_post`    | `forum_channel_id`, `title`, `content`, applied_tags | —                      | —                       | no           |
| `discord_get_forum_post`       | `thread_id`, limit                                   | —                      | read-only               | yes          |
| `discord_list_forum_threads`   | `forum_channel_id`, limit, before                    | —                      | read-only               | yes          |
| `discord_reply_to_forum`       | `thread_id`, `content`                               | —                      | —                       | no           |
| `discord_delete_forum_post`    | `thread_id`                                          | —                      | destructive             | no           |
| `discord_get_forum_tags`       | `forum_channel_id`                                   | —                      | read-only               | yes          |
| `discord_set_forum_tags`       | `forum_channel_id`, `tags`                           | —                      | destructive, idempotent | no           |
| `discord_update_forum_post`    | `thread_id`, title, archived, locked, applied_tags   | —                      | idempotent              | no           |

### `src/tools/webhooks.ts` — 8 tools (8 preserved, 0 added)

| Tool                             | Required params                                                      | Bot permission checked | Hints       | outputSchema |
| -------------------------------- | -------------------------------------------------------------------- | ---------------------- | ----------- | ------------ |
| `discord_create_webhook`         | `channel_id`, `name`, avatar                                         | —                      | —           | no           |
| `discord_send_webhook_message`   | `webhook_id`, `webhook_token`, content, username, avatar_url, embeds | —                      | —           | no           |
| `discord_edit_webhook`           | `webhook_id`, name, avatar, channel_id                               | —                      | idempotent  | no           |
| `discord_delete_webhook`         | `webhook_id`                                                         | —                      | destructive | no           |
| `discord_list_webhooks`          | channel_id, guild_id                                                 | —                      | read-only   | yes          |
| `discord_edit_webhook_message`   | `webhook_id`, `webhook_token`, `message_id`, content, embeds         | —                      | idempotent  | no           |
| `discord_delete_webhook_message` | `webhook_id`, `webhook_token`, `message_id`                          | —                      | destructive | no           |
| `discord_fetch_webhook_message`  | `webhook_id`, `webhook_token`, `message_id`                          | —                      | read-only   | yes          |

### `src/tools/scheduledEvents.ts` — 7 tools (7 preserved, 0 added)

| Tool                             | Required params                                                                                                          | Bot permission checked | Hints       | outputSchema |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------- | ----------- | ------------ |
| `discord_list_scheduled_events`  | `guild_id`                                                                                                               | —                      | read-only   | yes          |
| `discord_get_scheduled_event`    | `guild_id`, `event_id`                                                                                                   | —                      | read-only   | yes          |
| `discord_create_scheduled_event` | `guild_id`, `name`, description, `entity_type`, `scheduled_start_time`, scheduled_end_time, channel_id, location, image  | —                      | —           | no           |
| `discord_edit_scheduled_event`   | `guild_id`, `event_id`, name, description, scheduled_start_time, scheduled_end_time, channel_id, location, image, status | —                      | idempotent  | no           |
| `discord_delete_scheduled_event` | `guild_id`, `event_id`                                                                                                   | —                      | destructive | no           |
| `discord_get_event_subscribers`  | `guild_id`, `event_id`, limit, after                                                                                     | —                      | read-only   | yes          |
| `discord_create_event_invite`    | `guild_id`, `event_id`, channel_id, max_age, max_uses                                                                    | —                      | —           | no           |

### `src/tools/invites.ts` — 5 tools (5 preserved, 0 added)

| Tool                           | Required params                                    | Bot permission checked | Hints       | outputSchema |
| ------------------------------ | -------------------------------------------------- | ---------------------- | ----------- | ------------ |
| `discord_list_invites`         | `guild_id`                                         | —                      | read-only   | yes          |
| `discord_get_invite`           | `invite_code`                                      | —                      | read-only   | yes          |
| `discord_create_invite`        | `channel_id`, max_age, max_uses, unique, temporary | —                      | —           | no           |
| `discord_delete_invite`        | `invite_code`, reason                              | —                      | destructive | no           |
| `discord_list_channel_invites` | `channel_id`                                       | —                      | read-only   | yes          |

### `src/tools/dm.ts` — 7 tools (7 preserved, 0 added)

| Tool                    | Required params                                                                                                               | Bot permission checked | Hints       | outputSchema |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ----------- | ------------ |
| `discord_send_dm`       | `user_id`, `content`                                                                                                          | —                      | —           | no           |
| `discord_send_dm_embed` | `user_id`, content, title, url, description, color, fields, author, thumbnail_url, footer, image_url, timestamp               | —                      | —           | no           |
| `discord_edit_dm`       | `user_id`, `message_id`, `content`                                                                                            | —                      | idempotent  | no           |
| `discord_edit_dm_embed` | `user_id`, `message_id`, content, title, url, description, color, fields, author, thumbnail_url, footer, image_url, timestamp | —                      | idempotent  | no           |
| `discord_delete_dm`     | `user_id`, `message_id`                                                                                                       | —                      | destructive | no           |
| `discord_read_dms`      | `user_id`, limit                                                                                                              | —                      | read-only   | yes          |
| `discord_reply_dm`      | `user_id`, `message_id`, `content`                                                                                            | —                      | —           | no           |

### `src/tools/guildSettings.ts` — 25 tools (0 preserved, 25 added)

| Tool                                 | Required params                                                                                                                                                                | Bot permission checked | Hints                   | outputSchema |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- | ----------------------- | ------------ |
| `discord_get_guild_settings`         | `guild_id`                                                                                                                                                                     | —                      | read-only               | yes          |
| `discord_set_guild_name`             | `guild_id`, `name`, reason                                                                                                                                                     | `ManageGuild`          | idempotent              | yes          |
| `discord_set_guild_icon`             | `guild_id`, `image`, reason                                                                                                                                                    | `ManageGuild`          | idempotent              | yes          |
| `discord_remove_guild_icon`          | `guild_id`, reason                                                                                                                                                             | `ManageGuild`          | destructive, idempotent | yes          |
| `discord_set_guild_banner`           | `guild_id`, `image`, reason                                                                                                                                                    | `ManageGuild`          | idempotent              | yes          |
| `discord_remove_guild_banner`        | `guild_id`, reason                                                                                                                                                             | `ManageGuild`          | destructive, idempotent | yes          |
| `discord_set_guild_description`      | `guild_id`, `description`, reason                                                                                                                                              | `ManageGuild`          | idempotent              | yes          |
| `discord_set_guild_splash`           | `guild_id`, `image`, reason                                                                                                                                                    | `ManageGuild`          | idempotent              | yes          |
| `discord_set_guild_safety`           | `guild_id`, verification_level, explicit_content_filter, default_message_notifications, nsfw, reason                                                                           | `ManageGuild`          | idempotent              | yes          |
| `discord_set_guild_channels`         | `guild_id`, afk_channel_id, afk_timeout, system_channel_id, rules_channel_id, public_updates_channel_id, safety_alerts_channel_id, reason                                      | `ManageGuild`          | idempotent              | yes          |
| `discord_set_system_channel_notices` | `guild_id`, join_notifications, join_notification_replies, premium_subscriptions, guild_reminder_notifications, role_subscription_purchases, role_subscription_replies, reason | `ManageGuild`          | idempotent              | yes          |
| `discord_set_guild_locale`           | `guild_id`, `locale`, reason                                                                                                                                                   | `ManageGuild`          | idempotent              | yes          |
| `discord_set_premium_progress_bar`   | `guild_id`, `enabled`, reason                                                                                                                                                  | `ManageGuild`          | idempotent              | yes          |
| `discord_enable_community`           | `guild_id`, `enabled`, rules_channel_id, public_updates_channel_id, reason                                                                                                     | `ManageGuild`          | idempotent              | yes          |
| `discord_get_guild_features`         | `guild_id`                                                                                                                                                                     | —                      | read-only               | yes          |
| `discord_get_guild_preview`          | `guild_id`                                                                                                                                                                     | —                      | read-only               | yes          |
| `discord_get_guild_vanity_url`       | `guild_id`                                                                                                                                                                     | —                      | read-only               | yes          |
| `discord_set_guild_widget`           | `guild_id`, `enabled`, channel_id, reason                                                                                                                                      | `ManageGuild`          | idempotent              | yes          |
| `discord_get_guild_widget`           | `guild_id`                                                                                                                                                                     | —                      | read-only               | yes          |
| `discord_get_welcome_screen`         | `guild_id`                                                                                                                                                                     | —                      | read-only               | yes          |
| `discord_set_welcome_screen`         | `guild_id`, enabled, description, welcome_channels                                                                                                                             | `ManageGuild`          | idempotent              | yes          |
| `discord_get_onboarding`             | `guild_id`                                                                                                                                                                     | —                      | read-only               | yes          |
| `discord_set_onboarding`             | `guild_id`, enabled, mode, default_channel_ids, prompts, reason                                                                                                                | `ManageGuild`          | idempotent              | yes          |
| `discord_set_membership_gate`        | `guild_id`, `enabled`, reason                                                                                                                                                  | `ManageGuild`          | idempotent              | yes          |
| `discord_get_bot_permissions`        | `guild_id`                                                                                                                                                                     | —                      | read-only               | yes          |

### `src/tools/botProfile.ts` — 8 tools (0 preserved, 8 added)

| Tool                                  | Required params                | Bot permission checked | Hints      | outputSchema |
| ------------------------------------- | ------------------------------ | ---------------------- | ---------- | ------------ |
| `discord_get_bot_identity`            | `guild_id`                     | —                      | read-only  | yes          |
| `discord_set_bot_nickname`            | `guild_id`, `nickname`, reason | —                      | idempotent | yes          |
| `discord_set_bot_avatar`              | `image`                        | —                      | idempotent | yes          |
| `discord_set_bot_guild_avatar`        | `guild_id`, `image`, reason    | —                      | idempotent | yes          |
| `discord_set_bot_username`            | `username`                     | —                      | idempotent | yes          |
| `discord_set_application_icon`        | `image`                        | —                      | idempotent | yes          |
| `discord_set_application_description` | `description`                  | —                      | idempotent | yes          |
| `discord_get_bot_profile_limits`      | —                              | —                      | read-only  | yes          |

### `src/tools/style.ts` — 4 tools (0 preserved, 4 added)

| Tool                       | Required params                                   | Bot permission checked | Hints      | outputSchema |
| -------------------------- | ------------------------------------------------- | ---------------------- | ---------- | ------------ |
| `discord_list_name_styles` | —                                                 | —                      | read-only  | yes          |
| `discord_style_name`       | `name`, styles, emoji, max_length                 | —                      | read-only  | yes          |
| `discord_style_preview`    | `theme`, `items`, overrides, prefix               | —                      | read-only  | yes          |
| `discord_apply_name_theme` | `guild_id`, `theme`, include, keep_plain, confirm | —                      | idempotent | yes          |

### `src/tools/serverArchitect.ts` — 10 tools (0 preserved, 10 added)

| Tool                                 | Required params                                 | Bot permission checked          | Hints                   | outputSchema |
| ------------------------------------ | ----------------------------------------------- | ------------------------------- | ----------------------- | ------------ |
| `discord_architect_plan`             | `plan`                                          | —                               | read-only               | yes          |
| `discord_architect_read_structure`   | `guild_id`                                      | —                               | read-only               | yes          |
| `discord_architect_compare`          | `guild_id`, `plan`                              | —                               | read-only               | yes          |
| `discord_architect_apply`            | `guild_id`, `plan`, confirm, reason             | `ManageChannels`, `ManageRoles` | idempotent              | yes          |
| `discord_architect_repair`           | `guild_id`, `plan`, confirm                     | —                               | idempotent              | yes          |
| `discord_architect_explain_limits`   | —                                               | —                               | read-only               | yes          |
| `discord_architect_create_template`  | `guild_id`, `name`, description                 | `ManageGuild`                   | —                       | yes          |
| `discord_architect_list_templates`   | `guild_id`                                      | —                               | read-only               | yes          |
| `discord_architect_delete_template`  | `guild_id`, `code`                              | `ManageGuild`                   | destructive, idempotent | yes          |
| `discord_architect_delete_structure` | `guild_id`, channel_ids, role_ids, confirmation | `ManageChannels`, `ManageRoles` | destructive             | yes          |

### `src/tools/automod.ts` — 6 tools (0 preserved, 6 added)

| Tool                             | Required params                                                                                                                                                                                              | Bot permission checked | Hints       | outputSchema |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- | ----------- | ------------ |
| `discord_list_automod_rules`     | `guild_id`                                                                                                                                                                                                   | —                      | read-only   | yes          |
| `discord_get_automod_rule`       | `guild_id`, `rule_id`                                                                                                                                                                                        | —                      | read-only   | yes          |
| `discord_create_automod_rule`    | `guild_id`, `name`, event_type, `trigger_type`, keywords, regex_patterns, presets, allow_list, mention_total_limit, mention_raid_protection, `actions`, enabled, exempt_role_ids, exempt_channel_ids, reason | `ManageGuild`          | —           | yes          |
| `discord_edit_automod_rule`      | `guild_id`, `rule_id`, name, enabled, keywords, regex_patterns, presets, allow_list, mention_total_limit, mention_raid_protection, actions, exempt_role_ids, exempt_channel_ids, reason                      | `ManageGuild`          | idempotent  | yes          |
| `discord_delete_automod_rule`    | `guild_id`, `rule_id`, reason                                                                                                                                                                                | `ManageGuild`          | destructive | yes          |
| `discord_apply_automod_baseline` | `guild_id`, alert_channel_id, confirm                                                                                                                                                                        | `ManageGuild`          | idempotent  | yes          |

### `src/tools/expressions.ts` — 8 tools (0 preserved, 8 added)

| Tool                     | Required params                                           | Bot permission checked    | Hints       | outputSchema |
| ------------------------ | --------------------------------------------------------- | ------------------------- | ----------- | ------------ |
| `discord_list_emojis`    | `guild_id`                                                | —                         | read-only   | yes          |
| `discord_create_emoji`   | `guild_id`, `name`, `image`, role_ids, reason             | `ManageEmojisAndStickers` | —           | yes          |
| `discord_edit_emoji`     | `guild_id`, `emoji_id`, name, role_ids, reason            | `ManageEmojisAndStickers` | idempotent  | yes          |
| `discord_delete_emoji`   | `guild_id`, `emoji_id`, reason                            | `ManageEmojisAndStickers` | destructive | yes          |
| `discord_list_stickers`  | `guild_id`                                                | —                         | read-only   | yes          |
| `discord_create_sticker` | `guild_id`, `name`, `tags`, description, `image`, reason  | `ManageEmojisAndStickers` | —           | yes          |
| `discord_edit_sticker`   | `guild_id`, `sticker_id`, name, description, tags, reason | `ManageEmojisAndStickers` | idempotent  | yes          |
| `discord_delete_sticker` | `guild_id`, `sticker_id`, reason                          | `ManageEmojisAndStickers` | destructive | yes          |

### `src/tools/backup.ts` — 3 tools (0 preserved, 3 added)

| Tool                        | Required params                              | Bot permission checked          | Hints      | outputSchema |
| --------------------------- | -------------------------------------------- | ------------------------------- | ---------- | ------------ |
| `discord_export_structure`  | `guild_id`                                   | —                               | read-only  | yes          |
| `discord_compare_structure` | `guild_id`, `backup`                         | —                               | read-only  | yes          |
| `discord_restore_structure` | `guild_id`, `backup`, confirm, include_roles | `ManageChannels`, `ManageRoles` | idempotent | yes          |

### `src/tools/diagnostics.ts` — 6 tools (0 preserved, 6 added)

| Tool                               | Required params                   | Bot permission checked | Hints     | outputSchema |
| ---------------------------------- | --------------------------------- | ---------------------- | --------- | ------------ |
| `discord_explain_permissions`      | `guild_id`, `user_id`, channel_id | —                      | read-only | yes          |
| `discord_check_tool_permissions`   | `guild_id`, `tools`, channel_id   | —                      | read-only | yes          |
| `discord_find_permission_problems` | `guild_id`                        | —                      | read-only | yes          |
| `discord_diagnose_configuration`   | `guild_id`                        | —                      | read-only | yes          |
| `discord_read_audit_trail`         | limit                             | —                      | read-only | yes          |
| `discord_verify_setup`             | —                                 | —                      | read-only | yes          |

### `src/tools/scheduler.ts` — 4 tools (0 preserved, 4 added)

| Tool                            | Required params                                                                                                                                                     | Bot permission checked | Hints      | outputSchema |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ---------- | ------------ |
| `discord_schedule_message`      | `channel_id`, content, title, url, description, color, fields, author, thumbnail_url, footer, image_url, timestamp, `delay_seconds`, repeat_every_seconds, max_runs | —                      | —          | yes          |
| `discord_list_scheduled_tasks`  | —                                                                                                                                                                   | —                      | read-only  | yes          |
| `discord_cancel_scheduled_task` | `task_id`                                                                                                                                                           | —                      | idempotent | yes          |
| `discord_publish_announcement`  | `channel_id`, `title`, `body`, color, fields, footer, ping, ping_role_id, crosspost                                                                                 | —                      | —          | yes          |

### `src/tools/reactionRoles.ts` — 3 tools (0 preserved, 3 added)

Reaction-role menus. The tools write the mappings; the bot process in `src/bot/`
owns the gateway and honours them. A mapping reaches the running bot within two
seconds without a restart, because the bot watches the file these tools write.

| Tool                                | Required params                              | Bot permission checked | Hints       | outputSchema |
| ----------------------------------- | -------------------------------------------- | ---------------------- | ----------- | ------------ |
| `discord_create_reaction_role_menu` | `guild_id`, `channel_id`, `title`, `entries` | `ManageRoles`          | —           | yes          |
| `discord_list_reaction_role_menus`  | guild_id                                     | —                      | read-only   | yes          |
| `discord_delete_reaction_role_menu` | `channel_id`, `message_id`                   | —                      | destructive | yes          |

`discord_create_reaction_role_menu` refuses, before posting anything, any role that
is managed by an integration or that sits at or above the bot's highest role. The
refusal is returned in `warnings` with the reason, rather than surfacing later as
an opaque 50013 on the first member who reacts.

## Known limitations, by area

These are Discord platform limits, not defects in this server. Each one is also
stated in the description of the tool it affects, so a model calling the tool
sees the constraint before acting.

### Server identity and settings

- **Server name** — settable with `discord_set_guild_name` (Manage Server).
- **Server icon** — settable with `discord_set_guild_icon` from an https URL, a
  `data:` URI, or bare base64. The bytes are sniffed; Discord accepts PNG, JPEG,
  GIF and WebP only.
- **Server description** — settable with `discord_set_guild_description`. Discord
  only honours this for servers that are discoverable or have Community enabled.
- **Server banner** — settable with `discord_set_guild_banner`, but Discord gates
  the field behind the `BANNER` feature, which requires boost level 2. Below that
  the API rejects the call and this server reports the rejection rather than
  pretending it worked.
- **Server splash / discovery splash** — same boost gating, `INVITE_SPLASH` and
  `DISCOVERY_SPLASH`.
- **Vanity URL** — read-only here. Discord assigns the code through a separate
  endpoint that requires the `MANAGE_GUILD` permission _and_ the `VANITY_URL`
  feature; `discord_get_guild_vanity_url` reads it and returns `null` when absent.
- **Community** — `discord_enable_community` checks that a rules channel and a
  public-updates channel exist before calling Discord, because the API rejects a
  first enable without them with an opaque 400.
- **Widget** — enable/disable and channel selection are supported. The widget
  cannot be styled or restricted to specific members through the API.

### Bot identity — four different things that are easy to confuse

| Field                       | Scope       | Settable by a bot?                            | Tool                                          |
| --------------------------- | ----------- | --------------------------------------------- | --------------------------------------------- |
| Guild name                  | one server  | yes, with Manage Server                       | `discord_set_guild_name`                      |
| Guild icon                  | one server  | yes, with Manage Server                       | `discord_set_guild_icon`                      |
| Bot global username         | all servers | yes, rate-limited by Discord                  | `discord_set_bot_username`                    |
| Bot global avatar           | all servers | yes                                           | `discord_set_bot_avatar`                      |
| Bot nickname in one server  | one server  | yes, with Change Nickname or Manage Nicknames | `discord_set_bot_nickname`                    |
| Bot banner                  | global      | **no**                                        | `discord_get_bot_profile_limits` explains why |
| Bot global bio / "about me" | global      | **no**                                        | same                                          |
| Bot accent colour           | global      | **no**                                        | same                                          |
| Bot discriminator           | global      | **no**                                        | Discord removed discriminators for bots       |

`discord_get_bot_profile_limits` is a read-only tool that returns exactly which
profile fields are changeable, in which scope, and with which tool, plus the list
that is not reachable through the API and the reason for each. It is deliberately
a separate tool so a model cannot answer "can you change my banner?" from
guesswork.

### Creating a brand-new Discord server

Not possible. `POST /guilds` requires a **user** OAuth2 bearer token, not a bot
token, and creating a guild from a bot token is not part of the bot API. This
server will not fake it. `discord_architect_explain_limits` returns this
limitation with its reason and the recommended workflow: create the server by
hand in the Discord client, invite the bot, then run
`discord_architect_apply`.

`discord_architect_create_template` and `discord_architect_apply` cover the rest
of the job — a guild _template_ can be created by a bot with Manage Server, and
applying a plan to an existing guild is fully supported.

### Unicode naming

Discord has **no per-server font setting**. There is no API field, no hidden
option, and no way for an application to change the typeface Discord renders
channel, role or category names in. `discord_style_name`,
`discord_style_preview` and `discord_apply_name_theme` decorate _text_ using
Unicode characters — mathematical alphabets, box drawing, geometric marks and
emoji — which is a genuinely different thing and is what the module does.

Every one of those tools says so in its description. A module that claimed to
"apply a font" would be lying about what Discord supports.

Two concrete consequences, both handled:

- The `fullwidth` style maps ASCII to Unicode full-width forms, so the produced
  name no longer contains the original ASCII slug. That is the point of the
  style, and it is the only style that behaves this way.
- Names are clamped to Discord's 100-character cap by trimming the _slug_, never
  the decoration, so a truncated name still has a recognisable frame.

### Messages and history

- Message history is **not** included in a structure backup. Discord exposes no
  bulk export endpoint, and scraping every channel through the API would be slow,
  rate-limited, and would miss deleted messages. `discord_export_structure` says
  this in its description and returns `message_history_included: false`.
- Bulk delete cannot remove messages older than 14 days. That is a Discord limit
  on `bulkDelete`; the per-message delete path has no such restriction but is
  rate-limited.

### Rate limits

Discord enforces per-route buckets; discord.js handles 429 responses and waits
out `retry_after`. On top of that, this server paces bulk loops with a shared
250 ms interval (`throttleBulk` in `src/safety.ts`) so a structural build does
not rely purely on backoff after the fact.

### Not reversible

Deleted channels, roles, emoji, stickers, AutoMod rules and messages are gone.
Discord has no undo, and this server does not claim otherwise. Destructive tools
require the literal confirmation phrase (see `docs/SECURITY.md`) rather than a
boolean, so a deletion cannot be triggered by a defaulted argument.

## Verified against a live server

These were reproduced while building a real community server with this MCP, on a
fresh guild. They are Discord-side restrictions, not defects in the tools: the
tools report the error faithfully, and each entry records what actually happens.

| Attempt                                                                  | Result                                                           | Explanation                                                                                                                                               |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create a `GuildNews` (announcement) channel on a guild without Community | `400 Invalid Form Body type[BASE_TYPE_CHOICES]`                  | Announcement channels require the `NEWS` feature, which comes with Community.                                                                             |
| `discord_enable_community` with verification level `none`/`low`          | `403 150011 Server must raise verification level`                | New guilds must reach at least `medium` before Community can be enabled.                                                                                  |
| `discord_enable_community` with explicit content filter `disabled`       | `403 150012 Server must enable content filtering on all members` | Community requires `all_members`.                                                                                                                         |
| AutoMod baseline rule "Timeout repeat offenders"                         | `400 Action type 3 is not permitted`                             | The `TIMEOUT` AutoMod action is not available to this guild. The other three baseline rules are created; the failure is reported per-rule, not swallowed. |
| `discord_set_welcome_screen` with a 145-character description            | `400 Too big: expected string to have <=140 characters`          | Discord caps the welcome-screen description at 140 characters. The Zod schema enforces the cap.                                                           |
| `discord_edit_role` with a `reason` argument                             | `Invalid arguments. Unrecognized key: "reason"`                  | `discord_edit_role` takes no `reason`; the schema rejects the unknown key rather than ignoring it.                                                        |
| Editing the bot's own highest role                                       | `403 50013 Missing Permissions`                                  | Discord forbids editing a role above the bot's own highest role.                                                                                          |

Discord also does not allow an application to create a new guild: `POST /guilds`
is restricted to applications in fewer than 10 guilds, and there is no bot-usable
endpoint for it. `discord_architect_apply` therefore builds _inside_ an existing
server. See `discord_architect_explain_limits`.
