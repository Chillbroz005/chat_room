# Blink chat rooms

Blink is a temporary chat website with its API hosted by Cloudflare Pages Functions and room data stored in Cloudflare D1. The app polls for chat updates every 10 seconds. It does not use Firebase.

## Features

- Create a room with a generated or custom name and optional password.
- Browse rooms and see the host, creation date, expiry, description, and member count.
- Set room lifetime from one minute to 30 days.
- Chat with text, categorized emoji, GIPHY GIFs, and stickers. Text is limited to 255 characters.
- Room admins can delete messages, edit room details/password/expiry, block or mute members, nominate admins, and view the activity log.
- Room creators can permanently delete their room. Admin badges are shown in chat.
- A master admin code can access all active rooms.
- Join and leave events appear in chat. Expired rooms are removed as requests reach the API.

## Deploy to Cloudflare Pages (free plan)

1. Sign in to Cloudflare and open **Workers & Pages**. Choose **Create application → Pages → Connect to Git** and select `Chillbroz005/chat_room`.
2. Set the build command to blank (or `exit 0`) and the build output directory to `.`. Deploy the project. Pages Functions are in the repository's `functions/` folder.
3. In Cloudflare, open **Workers & Pages → D1 SQL Database → Create database**. Name it `gather-rooms`.
4. Open the new database's **Console** and run the full SQL from [`migrations/0001_init.sql`](migrations/0001_init.sql).
5. If you already deployed the earlier Blink version, also run [`migrations/0002_room_admin_tools.sql`](migrations/0002_room_admin_tools.sql) once. This adds room ownership and mute controls; do not run it more than once.
6. Open the Pages project **Settings → Bindings → Add → D1 database binding**. Set the variable name to exactly `DB` and select `gather-rooms`.
7. In Pages **Settings → Variables and Secrets**, add these secrets:
   - `MASTER_ADMIN_CODE` = the private global admin code you choose
   - `GIPHY_API_KEY` = your free GIPHY API key from [GIPHY Developers](https://developers.giphy.com/)
8. Save and redeploy. Open the `*.pages.dev` URL, create a room, and test joining from another browser/device.

Enter the master code in the same optional admin password field when joining a room. Anyone with the master code can read and moderate every active room, change settings, and delete rooms. Keep the code private. The requested six-character code is convenient but weaker than a long random code; rotate it before sharing the site widely.

If you see “D1 binding DB is missing”, the binding was not saved under the exact name `DB`, or the project needs a new deployment after saving it.

## Local preview

The static page can be previewed with:

```powershell
python -m http.server 8000
```

The API needs Cloudflare Pages Functions and a D1 database, so room creation will not work from this basic static server. For local full-stack development, use Wrangler Pages dev after installing Wrangler and configuring a local D1 database.

## Notes

- Cloudflare's free plan has daily request and D1 usage quotas. A ten-second poll uses about 8,640 API requests per continuously active browser per day, plus normal room actions. If the site gets busy, increase the polling interval or review Cloudflare's current limits.
- A room password is stored as a salted PBKDF2 hash. Room admin passwords are random 8-character alphanumeric codes; their hashes are stored in D1. Keep admin passwords private.
- Browser visitor identities are stored in local storage. Clearing browser storage or switching devices creates a new identity, so blocking is not a strong identity check.
- GIF and sticker search calls GIPHY directly from the browser as its API requires. The app asks Pages for the API key at runtime, so the key is visible to visitors; GIPHY keys are public-client credentials. Its free beta key is rate limited to 100 searches/API calls per hour. See GIPHY's [API fee and rate details](https://support.giphy.com/hc/en-us/articles/10389869671322-Is-there-a-fee-for-using-GIPHY-s-API) and [integration requirements](https://developers.giphy.com/docs/api/).
- Messages cannot be deleted by their author. A room admin can delete messages, and deleted message contents are not recorded in the activity log.
