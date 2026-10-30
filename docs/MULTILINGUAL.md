# Multilingual servers — what Discord actually allows

This document records what a Discord bot can and cannot do for a multilingual
server, verified against the official Discord API documentation, plus the pattern
that large multilingual servers use. It exists so nobody re-derives it, and so
the tools are not oversold.

## The hard constraint: a bot cannot detect a member's language on join

This is the single most important fact. Three independent blocks, all verified:

| Attempt                          | Result                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------ |
| `User.locale` (account language) | Requires the OAuth2 `identify` scope, which a bot token does not have. **Unavailable.**    |
| `GUILD_MEMBER_ADD` gateway event | Contains **no** locale field.                                                              |
| Discord onboarding prompts       | Have **no** localization field at all. Verified field-by-field in the Guild resource docs. |
| `Interaction.locale`             | **Available**, but only after the member clicks something.                                 |

Conclusion: you do not detect the language, **you let the member choose it**. This
is what large multilingual servers do, and it is the only reliable approach.

The one exception worth knowing: `Interaction.locale` arrives on every
interaction, and application commands support `name_localizations` /
`description_localizations`. So a slash command can render its own name in the
member's language. Onboarding prompts cannot.

## The pattern large multilingual servers use

Derived from Discord's own guide
(<https://discord.com/safety/internationalization-of-a-community>) and cross-checked
against practitioner guides.

1. **One shared international zone** stays in English: announcements, rules, FAQ,
   general chat. Never split everything on day one — Discord explicitly recommends
   expanding one language at a time.
2. **Per-language zones** below it, each mirroring the same channel set. The
   recommended per-language set is: rules, announcements, general-chat, media, and
   a feedback channel so the community can steer its own section.
3. **Language roles named in their own language**, not in English. `Español`, not
   `Spanish`. A member who cannot read English still recognises their own language
   name at a glance. Flags alone are wrong: English has dozens of countries, and
   the Portuguese flag alienates Brazilians.
4. **Onboarding asks the question and grants role + channels.** The native
   onboarding frame is already translated by Discord — a Japanese client sees the
   "Next"/"Finish" buttons in Japanese for free. Only _your_ content needs
   translating.
5. **Translate the important content per language**: rules, server info, and
   announcements. Discord's guide is explicit on this point.
6. **Staff per language**, with a shared undisplayed staff role so no language
   team looks less important. Colour-code or nickname-prefix the moderators.

### Why the flag emoji matters

A flag emoji is language-neutral. It is the only selector that works for someone
who reads none of the languages on offer. That is why every language role and
channel here carries a flag **plus** the endonym (`🇯🇵 日本語`, not `🇯🇵` alone and
not `🇯🇵 Japanese`).

## Verified Discord limits

| Limit                                    | Value          | How it was found                                                      |
| ---------------------------------------- | -------------- | --------------------------------------------------------------------- |
| Options per onboarding prompt            | **12**         | Bisected live: 12 accepted, 13 rejected `TOO_MANY_ONBOARDING_OPTIONS` |
| Onboarding prompts per guild             | at least 3     | Three served and stored                                               |
| Default channels for advanced onboarding | **at least 7** | Documented; enforced on write                                         |
| Message content length                   | **2000**       | API rejected the 15-language rules post                               |
| Poll answers                             | 2–10           | Documented                                                            |
| Poll question                            | 300 chars      | Documented                                                            |
| Poll answer                              | 55 chars       | Documented                                                            |
| Poll duration                            | 1–768 hours    | Documented                                                            |
| Channel/role name                        | 100 chars      | Enforced in the style generator                                       |
| Guild description                        | 140 chars      | Hit while setting the Watchtower description                          |

The 12-option cap is the one that shapes the design: 15 languages do not fit in
one prompt, so they are split across a primary prompt (11 languages + a "my
language isn't here" bridge) and a secondary "more languages" prompt (4 + an
"other language" entry). A single-select primary prompt keeps the common case to
one click, and the bridge option is what lets a member reach the second prompt
instead of dead-ending.

> The cap was first written down as 10, from the single observation that 15 was
> rejected. Bisecting the real boundary showed 12 is accepted, so the language
> split was widened to use the two slots that were being wasted. Do not trust a
> "rejected at N" result as the cap: only a bracketing pair (N accepted, N+1
> rejected) gives the number.

## Applied to Watchtower

The app ships 17 locales (`lib/l10n/app_*.arb`): `ar as de en es es_419 fr hi id
it ja pt pt_BR ru th tr zh`. Korean is **not** shipped, so there is no Korean
role.

15 languages are exposed as roles and channels — the 17 app locales, minus `es_419`
(served by `es`) and `pt_BR` (served by `pt`):

| Emoji | Role / channel   | Native name      |
| ----- | ---------------- | ---------------- |
| 🇬🇧    | English          | English          |
| 🇫🇷    | Français         | Français         |
| 🇪🇸    | Español          | Español          |
| 🇧🇷    | Português        | Português        |
| 🇩🇪    | Deutsch          | Deutsch          |
| 🇮🇹    | Italiano         | Italiano         |
| 🇷🇺    | Русский          | Русский          |
| 🇸🇦    | العربية          | العربية          |
| 🇯🇵    | 日本語           | 日本語           |
| 🇨🇳    | 中文             | 中文             |
| 🇮🇳    | हिन्दी           | हिन्दी           |
| 🇮🇩    | Bahasa Indonesia | Bahasa Indonesia |
| 🇹🇭    | ไทย              | ไทย              |
| 🇹🇷    | Türkçe           | Türkçe           |
| 🇮🇳    | অসমীয়া          | অসমীয়া          |

Structure:

- Category `━━・🌍・LANGUAGES・━━` — 15 channels, one per language, each with a
  localized topic.
- Onboarding — 3 prompts, 22 options:
  1. `🌍 Choose your language` — single-select, required, 12 options: the 11 most
     common languages plus a `🌐 My language isn't here` bridge. Each language
     grants its role **and** reveals its channel; the bridge grants none, it just
     keeps the flow moving so a member whose language is further down is not stuck.
  2. `🌏 More languages` — single-select, optional, 5 options: the remaining 4
     languages plus a `✍️ Other language` entry pointing at `#💬・general-chat`.
  3. `🎭 What are you into?` — multi-select, optional, 5 interests. Each option
     grants its role **and** lists the channels of its category, so the interest
     picks act as a second way to reveal the topic channels.
- `#📜・rules` — the rules translated into all 15 languages across 3 messages
  (the 2000-character cap), followed by a pinned welcome banner embed that walks a
  new member through language → rules → interests.
- Each language channel carries a pinned welcome post in that language.

The interest options name channels, not just roles, because a role on its own
reveals nothing here: every interest category is public, so a member who picks
"Anime" gets the role and the channels in one step instead of having to hunt for
them. Note the limits of that: because the categories are public, the roles do
not _hide_ anything — locking a category behind a role would remove access from
members who already had it.

## Security note: language roles must not grant MentionEveryone

Every role here inherits `@everyone`'s permissions at creation. The server's
`@everyone` role carried `MentionEveryone`, which meant **every self-assignable
role also carried it** — any member could ping the whole server. Fixed by removing
`MentionEveryone` from `@everyone` itself, then rewriting each role's explicit
permission set to a safe allowlist.

Rules for a self-assignable role:

- No `MentionEveryone`, no `ManageRoles`, no `Administrator`. Anything a role
  grants, a member grants themselves by picking it.
- Keep it low in the hierarchy so it never overrides staff or booster colours.
- Leave `mentionable` off to prevent role-ping spam.

## What still cannot be done

- **No automatic language detection on join.** Not an implementation gap — the API
  does not expose it.
- **No localized onboarding prompts.** Discord does not accept localization for
  them. The workaround is a flag-based selector, which is language-neutral.
- **No localized channel or role names.** Discord stores one name per channel.
  This is why the multilingual design uses one channel per language rather than
  trying to translate a single channel.
- **No native auto-translation.** Every message posted in one language stays in
  that language. Translation needs a bot, which is why Fergun is the one
  third-party bot recommended for translation.

## Rules acceptance: what actually works

A "react with ✅ to accept the rules" gate cannot be built by this MCP server, and
that is an architectural fact, not a missing feature:

- The server runs over **stdio** and connects to Discord lazily, on the first tool
  call. It has no long-lived gateway listener, so nothing is awake to see a
  reaction land.
- The client does not even request the `GuildMessageReactions` intent, so reaction
  events are never delivered. Adding the intent would not help on its own: a
  stdio server is only running while its host is driving it.

The reaction on the pinned welcome banner is therefore a **visual affordance**, not
an enforced gate. The gate that Discord does enforce is **membership screening**:
the member cannot post until they accept the form. The server configures that form
with `discord_update_membership_screening`.

One further limit, verified live: `discord_set_membership_gate` cannot **enable**
the screening gate. Discord answers HTTP 200 to a `PATCH /guilds/{id}` that adds
`MEMBER_VERIFICATION_GATE_ENABLED` and then silently drops the feature — the
returned `features` array is unchanged. It must be switched on once by hand in the
client (Server Settings → Safety Setup → Membership Screening). The tool reports
the real post-call state, so a refusal shows up as `enabled: false` rather than a
false success.
