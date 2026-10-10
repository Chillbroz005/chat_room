# Husky Chat Room

A lightweight, temporary chat-room web app built on **Cloudflare Pages Functions** and **Cloudflare D1**. Create rooms, invite people, and chat with text, emoji, GIFs, and stickers—without Firebase.

<p align="center">
  <strong>Simple rooms · Temporary conversations · Cloudflare-native backend</strong>
</p>

## Features

- **Room management** — create rooms with generated or custom names, optional passwords, descriptions, and configurable lifetimes from one minute to 30 days.
- **Live chat** — messages, categorized emoji, GIPHY GIFs, and stickers; message text is limited to 255 characters.
- **Room moderation** — admins can edit room settings, manage passwords and expiry, mute or block members, promote or demote admins, delete messages, and review room activity.
- **Ownership controls** — room creators can permanently delete their rooms; a master administrator can manage active rooms globally.
- **Member activity** — join/leave events, member counts, host information, creation dates, and expiry details.
- **Notifications** — `@creator` can send a room mention to a configured Telegram destination; `@admin` alerts room administrators.
- **Server-issued browser identity** — signed session cookies replace trust in client-supplied visitor IDs.
- **Security headers** — API responses include security-related headers.

## Tech stack

| Layer | Technology |
| --- | --- |
| Frontend | HTML, CSS, JavaScript |
| Serverless API | Cloudflare Pages Functions |
| Database | Cloudflare D1 (SQLite) |
| GIF and sticker search | GIPHY API |
| Optional notifications and replies | Telegram Bot API |

## Architecture

```text
Browser
  ├── Static UI and chat interactions
  └── /api/* requests
         └── Cloudflare Pages Functions
                ├── Signed browser-session identity
                ├── Room and moderation API
                ├── Telegram webhook integration
                └── Cloudflare D1
```

The client polls for chat updates every 10 seconds. The application does not use Firebase.

## Deployment

### 1. Connect the repository to Cloudflare Pages

1. In Cloudflare, open **Workers & Pages → Create application → Pages → Connect to Git**.
2. Select `Chillbroz005/chat_room`.
3. Use `.` as the build output directory. No build command is required for the static frontend.
4. Deploy the project. The `functions/` directory provides the Pages Functions API.

### 2. Create and bind the D1 database

1. Create a D1 database named `gather-rooms`.
2. In the database Console, run the SQL in [`migrations/0001_init.sql`](migrations/0001_init.sql).
3. For an existing deployment that has not applied the later migrations, apply each required migration once and in order:
   - [`migrations/0002_room_admin_tools.sql`](migrations/0002_room_admin_tools.sql)
   - [`migrations/0003_telegram_replies.sql`](migrations/0003_telegram_replies.sql)
4. In your Pages project, open **Settings → Bindings**, add a D1 database binding, set its variable name to exactly `DB`, and select `gather-rooms`.

Do not rerun a migration against a database where it has already been applied.

### 3. Configure secrets and variables

In **Workers & Pages → your Pages project → Settings → Variables and Secrets**, configure the values below. Use the appropriate production environment and redeploy after changing settings.

| Name | Purpose |
| --- | --- |
| `SESSION_SECRET` | Required. Random secret of at least 32 characters used to sign server-issued browser sessions. Keep it private and separate from every other secret. |
| `MASTER_ADMIN_CODE` | Private global administrator code. Anyone who has it can moderate active rooms and change room settings. |
| `GIPHY_API_KEY` | GIPHY API key for GIF and sticker search. |
| `TELEGRAM_BOT_TOKEN` | Optional Telegram bot token for notifications and replies. |
| `TELEGRAM_CHAT_ID` | Optional destination for creator notifications. |
| `TELEGRAM_CREATOR_USER_ID` | Optional numeric Telegram user ID authorized to send replies. |
| `TELEGRAM_WEBHOOK_SECRET` | Optional secret used to verify Telegram webhook requests; use the same value when registering the webhook. |

**Generate `SESSION_SECRET` securely.** For example, in PowerShell:

```powershell
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

Copy the generated value into Cloudflare's secret field. Do not commit it to Git, put it in frontend code, or share it publicly. The API intentionally fails closed when `SESSION_SECRET` is missing or too short.

The master administrator code is powerful: keep it private and use a strong value. It is separate from `SESSION_SECRET`.

### 4. Verify the deployment

After saving bindings and secrets, redeploy and check:

1. The site loads without browser-console errors.
2. A room can be created and joined from separate browsers or devices.
3. Password-protected rooms and expiry behave as expected.
4. Room moderation is limited to authorized administrators.
5. Telegram features work only if their optional configuration is complete.

If the API reports that the `DB` binding is missing, verify the exact binding name and redeploy. If session setup is reported as incomplete, confirm that `SESSION_SECRET` is configured in the environment serving the site.

## Optional Telegram integration

Telegram integration lets users mention the creator and lets the configured creator reply to a room without joining it directly.

1. Start a private chat with your bot using `/start`.
2. Obtain your numeric Telegram user ID and configure `TELEGRAM_CREATOR_USER_ID`. If a webhook is active, use your existing webhook/logging workflow; Telegram's `getUpdates` and webhook delivery cannot be used simultaneously.
3. Configure `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_CREATOR_USER_ID`, and `TELEGRAM_WEBHOOK_SECRET` in Cloudflare.
4. Register the webhook at `https://YOUR-PROJECT.pages.dev/api/telegram-webhook`, using the same secret as Telegram's `secret_token` and allowing the `message` update type.
5. In a room, use `@creator` to trigger a notification. Reply directly to the notification or send `/reply ROOMCODE your message` to the bot.

PowerShell example (prompts for secrets rather than embedding them in the command):

```powershell
$token = Read-Host "Bot token"
$secret = Read-Host "Webhook secret"
$body = @{
  url = "https://YOUR-PROJECT.pages.dev/api/telegram-webhook"
  secret_token = $secret
  allowed_updates = @("message")
} | ConvertTo-Json -Compress
Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$token/setWebhook" -ContentType "application/json" -Body $body
```

References: [Telegram setWebhook](https://core.telegram.org/bots/api#setwebhook) · [Webhook secret token](https://core.telegram.org/bots/api#setwebhook).

## Local preview

For a static UI preview, run:

```powershell
python -m http.server 8000
```

Then open `http://localhost:8000`. This simple server does not run Cloudflare Pages Functions, so API-backed features such as room creation will not work. For full-stack local development, use Wrangler Pages dev with a local D1 database.

## Security and operational notes

- **Session identity:** the server issues a signed, HttpOnly, Secure, SameSite cookie. Client-supplied visitor IDs are ignored. Clearing cookies or changing devices creates a new browser identity; moderation blocks are not proof of real-world identity.
- **Room passwords:** stored as salted PBKDF2 hashes. Keep administrator credentials private.
- **GIPHY:** GIF/sticker search uses the GIPHY API from the browser. Treat its API key as a public-client credential, not a secret. Review [GIPHY API documentation](https://developers.giphy.com/docs/api/) and [rate/fee details](https://support.giphy.com/hc/en-us/articles/10389869671322-Is-there-a-fee-for-using-GIPHY-s-API).
- **Polling and quotas:** the 10-second polling interval can generate about 8,640 requests per continuously active browser per day, before other actions. Review Cloudflare limits and adjust polling if usage grows.
- **Privacy and conduct:** the in-app notice is a user-facing reminder, not a substitute for a complete privacy policy, terms of service, or legal review.
- **Message deletion:** authors cannot delete their own messages. Room admins can delete messages; deleted message contents are not retained in the activity log.

## Project status

This repository is actively being hardened. Security and deployment guidance in this README describes the intended configuration; always validate changes in a staging deployment before relying on them in production. Automated and browser-level testing may still be required after changes.
