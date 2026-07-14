# Setting up ApplyPilot on a new Mac

**GitHub is the source of truth.** A single icon on your Desktop downloads the
latest code from GitHub, keeps the app updated whenever it safely can, and opens
it.

## The one-time setup

1. **Install the launcher.** Open **Terminal** (press ⌘-Space, type `Terminal`,
   press Return), paste this one line, and press Return:

   ```
   curl -fsSL https://raw.githubusercontent.com/Jvtino/Job-Applications-Project/main/launchers/ApplyPilot.command -o ~/Desktop/ApplyPilot.command && chmod +x ~/Desktop/ApplyPilot.command
   ```

   That puts the **ApplyPilot** icon on your Desktop, ready to run.

   *(Why not download it in the browser? Browsers drop the "this file may run"
   permission, and macOS then refuses to launch it. The Terminal line above
   avoids all of that.)*

2. **Double-click the icon.** If macOS still asks for permission the first time:
   **right-click** the icon → **Open** → **Open** — or on newer macOS,
   **System Settings → Privacy & Security → Open Anyway**.

3. **Let it set up.** The launcher checks for **git** and **Node.js 22+** and
   tells you exactly what to install if either is missing (click **Install** on
   the Command Line Tools popup; get Node from https://nodejs.org → green
   **LTS** button — then double-click the icon again). It then downloads the
   app, installs its dependencies and the automation browser — **this one-time
   step takes several minutes** — and opens ApplyPilot. Later launches are
   quick.

## Your private data and keys (never on GitHub, by design)

ApplyPilot is **local-first**: your profile, resumes, local database, and browser
logins stay on this Mac and are never uploaded. On a new Mac you set these up
fresh inside the app.

The app lives in the **`Job-Applications-Project`** folder in your Home folder
(the same location all the setup scripts use). To add your Anthropic API key,
paste this in Terminal:

```
cd ~/Job-Applications-Project && cp -n .env.example .env && open -t .env
```

then put your key after `ANTHROPIC_API_KEY=` and save. See `README.md` for the
full list of `.env` keys.

## Everyday use

Double-click **ApplyPilot** on the Desktop. It checks GitHub for a newer
version, updates and rebuilds when the code changed — and tells you if it can't
(for example, if files inside the app folder were edited locally) — then opens
the app. Once the ApplyPilot window is open, you can close the Terminal window
that appeared alongside it.
