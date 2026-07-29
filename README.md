# vibePilot — downloads

Installers for **vibePilot**, a local agent orchestrator for Windows.

**[Download the latest version](../../releases/latest)** — run `vibePilot Setup <version>.exe`.

Once installed, the app updates itself: it checks in the background, downloads quietly, and
installs when you next close it. Your projects, tickets and history are stored outside the
application folder and are never touched by an update.

There is also a portable `.exe` if you would rather not install anything. Note that the
portable build cannot update itself — download a newer one when you want it.

---

This repository holds build outputs only. The source lives elsewhere and is private; this is
public purely so the app can check for updates without shipping a credential inside it.
