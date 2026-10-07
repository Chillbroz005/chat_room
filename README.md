# Gather chat rooms

Gather is a static website with its API hosted by Cloudflare Pages Functions and room data stored in Cloudflare D1. The app polls for chat updates every 10 seconds. It does not use Firebase or require a paid server plan.

## Features

- Create a room with a generated or custom name and optional password.
- Browse rooms and see the host, creation date, expiry, description, and member count.
- Set room lifetime from one minute to 30 days.
- Chat with text, emoji, and HTTPS GIF links. Text and captions are limited to 255 characters.
- Admins can delete messages, change room details/password/expiry, block members, nominate another admin, and view the activity log.
- Join and leave events appear in chat. Expired rooms are removed as requests reach the API.

## Deploy to Cloudflare Pages (free plan)

1. Sign in to Cloudflare and open **Workers & Pages**. Choose **Create application → Pages → Connect to Git** and select `Chillbroz005/chat_room`.
2. Set the build command to blank (or `exit 0`) and the build output directory to `.`. Deploy the project. Pages Functions are in the repository's `functions/` folder.
3. In Cloudflare, open **Workers & Pages → D1 SQL Database → Create database**. Name it `gather-rooms`.
4. Open the new database's **Console** and run the full SQL from [`migrations/0001_init.sql`](migrations/0001_init.sql).
5. Open the Pages project **Settings → Functions → D1 database bindings → Add binding**. Set the variable name to exactly `DB` and select `gather-rooms`. Save, then trigger a new deployment so the Functions receive the binding.
6. Open the `*.pages.dev` URL shown on the Pages project. Create a room and test joining from another browser/device.

If you see “D1 binding DB is missing”, the binding was not saved under the exact name `DB`, or the project needs a new deployment after saving it.

## Local preview

The static page can be previewed with:

```powershell
python -m http.server 8000
```

The API needs Cloudflare Pages Functions and a D1 database, so room creation will not work from this basic static server. For local full-stack development, use Wrangler Pages dev after installing Wrangler and configuring a local D1 database.

## Notes

- Cloudflare's free plan has daily request and D1 usage quotas. A ten-second poll uses about 8,640 API requests per continuously active browser per day, plus normal room actions. If the site gets busy, increase the polling interval or review Cloudflare's current limits.
- A room password is stored as a salted PBKDF2 hash. The admin password is a randomly generated bearer key whose hash is stored in D1. Keep admin passwords private.
- Browser visitor identities are stored in local storage. Clearing browser storage or switching devices creates a new identity, so blocking is not a strong identity check.
- GIFs are direct HTTPS links. The app does not connect to a GIF search provider.
- Messages cannot be deleted by their author. A room admin can delete messages, and deleted message contents are not recorded in the activity log.
