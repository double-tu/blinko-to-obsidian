# Blinko Sync

Blinko Sync is an Obsidian community plugin that bridges a self‑hosted [Blinko](https://github.com/blinko-space/blinko) “flash note” server with your local knowledge base. It continuously imports new or updated Blinko notes, rewrites attachment references so they work offline inside Obsidian, and optionally removes local copies when the source note is deleted or moved to the recycle bin.

---

## Background & Motivation

Many users capture quick thoughts, voice notes, and images in Blinko but do long‑form writing or knowledge management in Obsidian. Moving content between the two systems manually is tedious and error‑prone. Blinko Sync automates this workflow:

1. Poll Blinko’s API on demand or on a schedule.
2. Fetch notes and binary attachments incrementally (based on `updatedAt`).
3. Convert each item into Markdown (`blinko-{id}.md`) with rich frontmatter.
4. Rewrite any inline attachment URLs to Obsidian wikilinks and download the files.
5. (Optional) Detect deletions/recycle‑bin items upstream and purge the local copies.

The result is a continuously updated “Blinko” folder inside your vault that mirrors the canonical truth from your server.

---

## Feature Overview

- **Configurable sync targets**: separate folders for notes and attachments.
- **Incremental sync**: tracks `lastSyncTime` to avoid re-downloading unchanged items.
- **Attachment handling**:
  - Downloads referenced images/audio once.
  - Rewrites Markdown embeds (`![...](url)`) to local `![[filename]]`.
  - Appends wiki embeds for attachments not explicitly referenced in the body.
- **Typed metadata**: frontmatter stores id, timestamps, `blinkoType` (`flash`, `note`, `todo`), tags, and `blinkoAttachments`.
- **Manual + automatic triggers**: ribbon icon, command palette, and background interval.
- **Deletion reconciliation**:
  - Base mode removes local copies when the remote note truly disappears.
  - Optional toggle also removes notes that currently sit in Blinko’s recycle bin.
- **Diagnostics**: granular logging via the Debug mode toggle.

---

## Installation & Setup

1. **Clone / build**  
   ```bash
   npm install
   npm run build
   ```
   Copy `manifest.json`, `main.js`, and `styles.css` into `<Vault>/.obsidian/plugins/blinko-to-obsidian/`.

2. **Enable**  
   In Obsidian, go to **Settings → Community plugins**, enable **Blinko Sync**, and open its settings tab.

3. **Configure settings**
   - **Server URL** – Base URL pointing to your Blinko API (e.g., `https://example.com/api`).
   - **Access token** – Bearer token for authenticated requests.
   - **Note folder / Attachment folder** – Relative paths inside the vault.
   - **Auto sync interval** – Minutes between background syncs (`0` disables).
   - **Deletion check** – Toggle + interval for removing local notes when deleted upstream.
   - **Recycle-bin deletion** – Optional toggle to also remove notes that are merely in Blinko’s recycle bin.
   - **Debug mode** – Writes verbose logs (`[Blinko Sync] ...`) to the developer console.
   - **Last sync time** – Inspect or reset the stored timestamp to re-import everything.
   - **Manual sync button** – Run one sync immediately from the settings panel.

---

## Usage Workflow

1. **Manual sync**  
   Click the ribbon icon or run the `Sync Blinko` command. Status bar text flips to “Blinko Syncing…”. When finished you’ll see a toast with the count of new notes.

2. **Automatic sync**  
   When the interval is non-zero, the plugin schedules a background sync. It uses the same logic as the manual call, so the vault stays updated even when you forget to run it.

3. **Deletion reconciliation**  
   - Enable **Deletion check** to periodically compare local `blinko-*.md` files against the server using `note/list-by-ids`. Missing items are removed along with their attachments.
   - Enable **Delete notes in recycle bin** if you want items currently in Blinko’s recycle bin to vanish locally as well.
   - Run the `Blinko: reconcile deletions` command at any time for an immediate cleanup.

4. **Resulting files**  
   - Notes live under `Note folder` as `blinko-{id}.md`.
   - Attachments live under `Attachment folder`.
   - Frontmatter example:
     ```yaml
     ---
     id: 42
     date: 2024-01-01T10:00:00.000Z
     updated: 2024-01-02T11:00:00.000Z
     source: blinko
     blinkoType: flash
     blinkoTypeCode: 0
     blinkoAttachments: ["photo.png", "recording.webm"]
     tags: ["work/tasks", "ideas"]
     ---
     ```

---

## Tips & Troubleshooting

- **HTML response error** – Usually means the Server URL points to a UI page. Ensure it ends at the API root so `/v1/note/list` returns JSON.
- **Attachment 404s** – Double-check any reverse proxy rewrites. The plugin now resolves both relative (`/api/...`) and absolute URLs using your base origin.
- **Large imports** – Use the “Reset last sync time” button to replay from scratch. The sync loop paginates 50 notes at a time until it reaches the previous `lastSyncTime`.
- **Debugging** – Turn on Debug mode and inspect the console for `[Blinko Sync]` logs to see API URLs, downloaded files, and deletion actions.

---

## Development Notes

- Tooling: TypeScript, esbuild, npm.
- Commands:
  ```bash
  npm run dev   # watch build
  npm run build # lint + bundle
  ```
- Release artifacts: `manifest.json`, `main.js`, `styles.css`.
- Contributions are welcome—split logic into modules under `src/` following the existing structure (client, sync manager, vault adapter, deletion manager, settings/types).

---

Enjoy seamless Blinko → Obsidian sync! If you have ideas or run into edge cases, feel free to open an issue or PR.***
