# AI Linzi

[简体中文说明](README.zh-CN.md)

AI Linzi connects Alina's business coaching service to a local knowledge Vault. It provides sidebar chat, local search, note-aware content workflows, AI illustrations, long-document processing, and WeChat formatting and publishing.

## Features

- Chat with AI Linzi in a sidebar. A current-note request uses the Markdown tab that is still open as the primary source; closing the tab revokes that exact-note context.
- Every compatible text-chat turn gives the currently selected model the same on-demand Vault tools. A named note or folder is searched first for speed, but it is not a hard read boundary; if needed, the model can continue searching the rest of the current Vault. No model can access files outside the Vault through these tools.
- Search Markdown, TXT, text-based PDF, DOCX, HTML, PPTX, and XLSX files locally.
- Ask for a whole-Vault workspace or directory review. The plugin sends the model one bounded metadata-only inventory (folder paths, file-type counts, sizes, modification times, and a short recent-file list), then reads only the few documents whose content is actually needed.
- Add `.xlsx` workbooks to the main chat from the Vault or directly from the computer. Computer workbooks are converted to bounded worksheet text on-device; the original file is never uploaded or saved in chat history. Legacy `.xls` files must first be saved as `.xlsx`.
- Pull images embedded in a .docx handout into the generated deck, placed where they appear in the source (parsed and compressed on-device).
- Build a presentable HTML slide deck from one explicitly selected Markdown, TXT, text-based PDF, or DOCX note: the server returns only a structured outline, the plugin assembles fixed local templates, and images are embedded on-device (three color themes; print to PDF from the browser).
- Run sales reviews and customer consultation briefs from one explicitly selected Markdown, TXT, text-based PDF, or DOCX transcript; the original file stays local. After a brief PNG is generated, its text can be revised directly in the main chat. The plugin keeps only the latest structured draft in local conversation data, sends it only to the brief-revision endpoint when requested, creates a new PNG without overwriting the prior image, and does not add a Markdown source file to the Vault.
- Send only a bounded set of relevant excerpts to the service.
- Explicitly select complete documents for authorized long-document tasks.
- Create new notes and folders after an in-app confirmation.
- Ask in natural language to save a reply as a new note, replace the still-open current note, save that note to the AI Linzi knowledge base, or persist an explicit first-person fact. Success is reported only after the requested write has actually completed.
- Search for a transcript in the main chat, read the selected file in bounded local steps, refine the result over multiple turns, then create, append, or precisely update a confirmed Markdown change set. Up to 12 notes can be included; every target is previewed and version-locked, and a failed step rolls the current change set back instead of leaving a partial result.
- Move explicitly requested files to the Trash/Recycle Bin after a separate confirmation. Any file type is eligible (including folders and attachments), and several targets can be batched into one confirmation; an explicit request to delete the current note uses the note path locked when the message was sent, so later tab changes cannot retarget it. Permanent deletion is never performed — items always go to the system Trash/Recycle Bin, and deletion requests must come from you in the current message.
- Generate or revise article illustrations and save successful images locally.
- Format WeChat articles and send them to a configured WeChat draft box.
- Turn a WeChat article into a publish-ready Xiaohongshu note with three title choices, 300–800 Chinese characters of copy, hashtags, and local 3:4 cards that mix the original images with surrounding text.
- Review a local four-platform publishing matrix, five-stage creation pipeline, account growth, and per-post performance for WeChat, Xiaohongshu, Channels, and Douyin. Platform screenshots are analyzed only after an explicit selection and require confirmation before local metrics are saved.
- Review local content activity and authorized account data in the one-person-company cockpit.
- Create, test, import, export, and update portable personal Skills in **Skill Studio** or by asking in the main chat. Imported and generated Skills use whole-Vault on-demand reading by default; there is no install-time folder permission choice, and a note or folder named at run time only narrows that run's search priority. A main-chat request that asks for both a reusable Skill and the current task can install and start it with one confirmation. Every update locks one installed Skill, shows all text changes and deletions, and writes only after one confirmation. The plugin does not create a separate Skill version history; if a write fails mid-update, it restores the affected files from an in-memory copy. Existing Skills can progressively read referenced files and—when the user separately enables local execution—request per-step confirmation for Node.js, Python, FFmpeg, or FFprobe actions. Shell command strings are not accepted.
- Generate a new HTML, DOCX, PDF, or PPTX deliverable through the same preview-and-confirm flow, or create an editable Markdown workspace whose cards refresh locally when Vault files change. Dynamic workspaces use metadata only, run no generated scripts, and never overwrite an existing file.

## Installation

Install AI Linzi from the Obsidian community plugin directory when the listing is available:

1. Open **Settings → Community plugins → Browse**.
2. Search for **AI Linzi**.
3. Select **Install**, then **Enable**.
4. Open the AI Linzi settings tab and paste a connection key created at [chat.alinalinzi.com](https://chat.alinalinzi.com/connections).

AI Linzi is currently desktop-only and requires Obsidian 1.11.4 or later.

## Privacy and network access

Local search remains dormant until the current model actually invokes a file-search or read tool. This capability belongs to the plugin and does not depend on a particular model provider. At that point the plugin builds a local, persistent search index and keeps it current from Obsidian Vault events. The index stores file metadata and a compact term-membership bitset, not document text, and is never uploaded. Search hits are re-read from the Vault before use. A user-named note or folder is treated as the first place to search, while the rest of the current Vault remains available on demand. For a normal chat request, the plugin sends only an explicitly requested still-open note, explicitly authorized documents, or a bounded set of locally matched excerpts. When the user requests a whole-Vault workspace, dashboard, or structural review, the plugin may additionally send one bounded metadata-only inventory: up to 240 folder paths, aggregate file-type/size counts, and up to 40 recently modified file paths with sizes and timestamps. The inventory contains no file content, is excluded from cloud chat history, and is used only for that tool loop. The plugin never uploads the whole Vault's contents, and the model never receives direct filesystem access.

The only supported file read outside the Vault is an `.xlsx` workbook that the user explicitly selects or drops into the chat. It is converted to bounded worksheet text on-device; the original workbook is not uploaded, copied into the Vault, or stored in chat history.

The plugin reads or writes Vault files only for user-triggered actions such as including a note, saving a generated result, creating or updating confirmed notes, creating a folder, inserting an image, or publishing a WeChat draft. Vault organization is plan-first and confirmation-gated: it can create folders, move, or rename without overwriting. A cross-file Markdown change set is limited to 12 exact paths, shows every complete addition, replacement, or local edit, locks each existing target version, and rolls back completed writes if a later operation fails. When the user explicitly asks to delete files, a delete-only plan lists every target (any file type, folders included, batched within one confirmation) and a separate confirmation moves them to the operating-system Trash/Recycle Bin or Obsidian `.trash`; folders containing protected paths are rejected as a whole, and the plugin never permanently deletes anything. Move/rename actions have a local undo log. Connection keys and WeChat AppSecrets use Obsidian SecretStorage and are not written to plugin settings or logs.

Cloud features require an AI Linzi account and connection key. Some AI features require a paid entitlement or credits managed on the AI Linzi website. User-triggered requests connect to `https://chat.alinalinzi.com`; WeChat draft publishing also connects to the official WeChat API. The plugin does not include client-side telemetry, advertising SDKs, or an independent updater.

Local program execution is disabled by default. If enabled, every action is shown for confirmation with its program, arguments, working directory, network declaration, timeout, expected output files, and whether a bounded terminal-output excerpt will be shared with the model. Terminal output is not shared by default and is never written to cloud chat history. The executor does not use a shell, rejects inline Node/Python code, remote FFmpeg inputs, and declared-output overwrites, and only runs Node/Python scripts that the active Skill has explicitly referenced and fully read. Scripts still run with the same operating-system permissions as Obsidian, so users must run only trusted Skills. Generated Vault files can be moved to the operating system Trash/Recycle Bin when they have not changed since generation.

Generated images and local conversation cards remain in the Vault or Obsidian-managed local plugin data. Cloud history contains text only and excludes local paths and image data. User-edited titles for Obsidian-plugin conversations are synced as account metadata so the same title can appear on another device; titles are not added to model prompts.

An installed Skill update uses one complete preview and one confirmation. The plugin rechecks the locked Skill immediately before writing and keeps the original affected bytes only in memory for automatic rollback during that operation. It does not create or retain plugin-managed Skill history. Normal Obsidian File Recovery, Trash, sync, or user backups remain available according to the user's own setup.

## Security and implementation notes

- The public repository is a thin client. Private prompts, model routing, billing, account data, and service-side orchestration remain on the AI Linzi service.
- Vault enumeration powers user-enabled local search and bounded read-tool results. Tool calls and local paths are excluded from cloud chat history.
- Dynamic workspace rendering and refresh run entirely inside Obsidian from a fixed, validated JSON specification. The generated Markdown cannot execute scripts, load remote code, or bypass the normal confirmation and no-overwrite checks.
- Clipboard access occurs only after an explicit user copy action.
- PDF.js is bundled for local extraction of text-based PDFs. Runtime code compilation is disabled during the production build, so PDF.js uses its built-in interpreter; the release scan requires zero dynamic `<script>`, `eval`, or `new Function` findings. No remote script or CDN is used.
- Streaming chat uses `fetch` because Obsidian's `requestUrl` API buffers the complete response and does not expose the response stream.
- The official release contains only `main.js`, `manifest.json`, and `styles.css`. GitHub Actions generates build-provenance attestations for these assets.

## Development

```bash
npm ci
npm run build
npm test
npm run check:marketplace
```

Every release tag must exactly match the version in `manifest.json`. The release workflow builds from source, verifies the version, creates provenance attestations, and publishes the three files supported by Obsidian's plugin installer.

## License

[MIT](LICENSE)
