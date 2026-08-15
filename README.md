# AI Linzi

[简体中文说明](README.zh-CN.md)

AI Linzi connects Alina's business coaching service to a local knowledge Vault. It provides sidebar chat, local search, note-aware content workflows, AI illustrations, long-document processing, and WeChat formatting and publishing.

## Features

- Chat with AI Linzi in a sidebar. A current-note request reads only a Markdown tab that is still open; closing the tab revokes that access.
- Search Markdown, TXT, text-based PDF, and DOCX files locally.
- Run sales reviews and customer consultation briefs from one explicitly selected Markdown, TXT, text-based PDF, or DOCX transcript; the original file stays local.
- Send only a bounded set of relevant excerpts to the service.
- Explicitly select complete documents for authorized long-document tasks.
- Create new notes and folders after an in-app confirmation.
- Move one explicitly requested Markdown note to the Trash/Recycle Bin after a separate confirmation; permanent deletion, folders, attachments, and batch deletion are not supported.
- Generate or revise article illustrations and save successful images locally.
- Format WeChat articles and send them to a configured WeChat draft box.
- Turn a WeChat article into a publish-ready Xiaohongshu note with three title choices, 300–800 Chinese characters of copy, hashtags, and local 3:4 cards that mix the original images with surrounding text.
- Review a local four-platform publishing matrix, five-stage creation pipeline, account growth, and per-post performance for WeChat, Xiaohongshu, Channels, and Douyin. Platform screenshots are analyzed only after an explicit selection and require confirmation before local metrics are saved.
- Review local content activity and authorized account data in the one-person-company cockpit.
- Create a basic personal Skill from the main chat, browse it under **My Skills**, and explicitly invoke its `SKILL.md`. Existing Skills can progressively read referenced files and—when the user separately enables local execution—request per-step confirmation for Node.js, Python, FFmpeg, or FFprobe actions. Shell command strings are not accepted.

## Installation

Install AI Linzi from the Obsidian community plugin directory when the listing is available:

1. Open **Settings → Community plugins → Browse**.
2. Search for **AI Linzi**.
3. Select **Install**, then **Enable**.
4. Open the AI Linzi settings tab and paste a connection key created at [chat.alinalinzi.com](https://chat.alinalinzi.com/connections).

AI Linzi is currently desktop-only and requires Obsidian 1.11.4 or later.

## Privacy and network access

Local search scans supported files in memory on the user's device. It does not create a cloud index or upload the whole Vault. For a normal chat request, the plugin sends only an explicitly requested still-open note, explicitly authorized documents, or a bounded set of locally matched excerpts. When the user asks to search their Vault, knowledge base, digital brain, or file repository, the service may request a bounded sequence of local search, folder listing, and document-read operations; the model never receives direct filesystem access.

The plugin reads or writes Vault files only for user-triggered actions such as including a note, saving a generated result, creating a confirmed note or folder, inserting an image, or publishing a WeChat draft. Vault organization is plan-first and confirmation-gated: it can create folders, move, or rename without overwriting. When the user explicitly asks to delete a single Markdown note, a separate confirmation can move only that note to the operating-system Trash/Recycle Bin or Obsidian `.trash`; the plugin never permanently deletes it. Move/rename actions have a local undo log. Connection keys and WeChat AppSecrets use Obsidian SecretStorage and are not written to plugin settings or logs.

Local program execution is disabled by default. If enabled, every action is shown for confirmation with its program, arguments, working directory, network declaration, timeout, expected output files, and whether a bounded terminal-output excerpt will be shared with the model. Terminal output is not shared by default and is never written to cloud chat history. The executor does not use a shell, rejects inline Node/Python code, remote FFmpeg inputs, and declared-output overwrites, and only runs Node/Python scripts that the active Skill has explicitly referenced and fully read. Scripts still run with the same operating-system permissions as Obsidian, so users must run only trusted Skills. Generated Vault files can be moved to the operating system Trash/Recycle Bin when they have not changed since generation.

Generated images and local conversation cards remain in the Vault or Obsidian-managed local plugin data. Cloud history contains text only and excludes local paths and image data.

## Security and implementation notes

- The public repository is a thin client. Private prompts, model routing, billing, account data, and service-side orchestration remain on the AI Linzi service.
- Vault enumeration powers user-enabled local search and bounded read-tool results. Tool calls and local paths are excluded from cloud chat history.
- Clipboard access occurs only after an explicit user copy action.
- PDF.js is bundled for local extraction of text-based PDFs. It supplies the dynamic-code finding reported by automated static analysis; no remote script or CDN is used.
- Streaming chat uses `fetch` because Obsidian's `requestUrl` API buffers the complete response and does not expose the response stream.
- The official release contains only `main.js`, `manifest.json`, and `styles.css`. GitHub Actions generates build-provenance attestations for these assets.

## Development

```bash
npm ci
npm run build
npm test
```

Every release tag must exactly match the version in `manifest.json`. The release workflow builds from source, verifies the version, creates provenance attestations, and publishes the three files supported by Obsidian's plugin installer.

## License

[MIT](LICENSE)
