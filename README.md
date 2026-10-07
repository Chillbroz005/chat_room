# Gather

A GitHub Pages chat-room front end backed by Firebase Authentication, Cloud Firestore, and callable Cloud Functions.

## Features

- Create rooms with a custom or generated room name, a custom or generated display name, a password, and an expiry from 1 minute to 30 days.
- Browse active rooms and see the room code, creator, creation time, expiry, description, and member count before joining.
- Join with the room password. Passwords are salted and hashed on the server. Five wrong attempts lock that account out of the room for 15 minutes.
- Live text and emoji chat, GIF links, a 255-character text/caption limit, and admin-only message deletion.
- Join/leave notices, live member presence, room rules and settings, password changes, admin nomination, user blocking, and an admin activity log.
- Expired rooms immediately stop working and are recursively removed by a scheduled Cloud Function.

## Firebase setup (one time)

1. Create a Firebase project and a Web app. In **Authentication → Sign-in method**, enable **Anonymous** sign-in.
2. Create a **Cloud Firestore** database. Copy the Web app config into `firebase-config.js`.
3. Install the Firebase CLI, sign in, and select the project from this folder:

   ```powershell
   npm install -g firebase-tools
   firebase login
   firebase use --add
   ```

4. Deploy the server functions and Firestore rules:

   ```powershell
   cd functions
   npm install
   cd ..
   firebase deploy --only functions,firestore:rules
   ```

   Cloud Functions and the scheduled expiry cleanup require a Firebase project on the **Blaze** plan. Set a billing budget alert in Google Cloud before enabling them. The cleanup function runs daily; Firestore rules deny access as soon as a room's expiry time passes.

5. In Firebase Authentication settings, add the GitHub Pages host (`CHILLBROZ005.github.io`) to **Authorized domains**.
6. Push this repository to GitHub. The included Pages workflow publishes the static files from the repository root. In the repository settings, set **Pages → Build and deployment → Source** to **GitHub Actions**.

## Local preview

Because the app uses browser ES modules, open it through a local web server rather than `file://`:

```powershell
python -m http.server 8000
```

Then visit `http://localhost:8000`.

## Notes

- The Firebase web config is public by design; Firestore rules and server functions enforce access. Never put service-account credentials in this repository.
- Anonymous accounts are browser based. Clearing browser data or switching devices creates a different identity, so a blocked person could return with a new anonymous account. Use a real sign-in provider if stronger identity-based blocking is needed.
- GIFs are shared as HTTPS image URLs. The interface does not include a third-party GIF search service or API key.
- The activity log records room events and admin actions; it does not retain copies of message text after deletion.
