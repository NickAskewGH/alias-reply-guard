"""Run an isolated Linux Thunderbird draft round-trip using only public APIs."""

import http.server
import json
import os
import pathlib
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import zipfile

root = pathlib.Path(tempfile.mkdtemp(prefix="alias-draft-probe-"))
print("Probe artifacts:", root, flush=True)
assets = pathlib.Path(__file__).resolve().parent
thunderbird = shutil.which("thunderbird")
if not thunderbird or not shutil.which("xvfb-run"):
    raise SystemExit("This Linux probe requires Thunderbird and xvfb-run.")
profile = pathlib.Path(tempfile.mkdtemp(prefix="profile-", dir=root))
profile.mkdir(exist_ok=True)
mail = profile / "Mail" / "Local Folders"
mail.mkdir(parents=True, exist_ok=True)
for name in ("Inbox", "Drafts", "Trash", "Unsent Messages"):
    (mail / name).touch()
results = []


class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        results.append(data)
        print(
            "Probe:",
            data["step"],
            data.get("scenario", data.get("message", "")),
            flush=True,
        )
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"OK")

    def log_message(self, *args):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
port = server.server_port
prefs = {
    "devtools.console.stdout.chrome": True,
    "extensions.logging.enabled": True,
    "extensions.autoDisableScopes": 0,
    "extensions.enabledScopes": 15,
    "xpinstall.signatures.required": False,
    "mail.provider.enabled": False,
    "mailnews.start_page.enabled": False,
    "mail.shell.checkDefaultClient": False,
    "app.update.enabled": False,
    "mail.accountmanager.accounts": "account1",
    "mail.accountmanager.defaultaccount": "account1",
    "mail.accountmanager.localfoldersserver": "server1",
    "mail.account.account1.server": "server1",
    "mail.account.account1.identities": "id1",
    "mail.server.server1.type": "none",
    "mail.server.server1.hostname": "Local Folders",
    "mail.server.server1.userName": "nobody",
    "mail.server.server1.name": "Probe Local Mail",
    "mail.server.server1.directory": str(mail),
    "mail.server.server1.directory-rel": "[ProfD]Mail/Local Folders",
    "mail.identity.id1.useremail": "private@example-domain.com",
    "mail.identity.id1.fullName": "Probe User",
    "mail.identity.id1.valid": True,
    "mail.identity.id1.compose_html": True,
    "mail.identity.id1.draft_folder": "mailbox://nobody@Local%20Folders/Drafts",
    "mail.identity.id1.drafts_folder_picker_mode": "0",
    "mail.identity.id1.doFcc": False,
    "mail.identity.id1.stationery_folder": "mailbox://nobody@Local%20Folders/Templates",
    "mail.identity.id1.archive_folder": "mailbox://nobody@Local%20Folders/Archives",
    "mailnews.message_display.disable_remote_image": True,
    "toolkit.telemetry.enabled": False,
}
(profile / "user.js").write_text(
    "\n".join(
        "user_pref(" + json.dumps(k) + ", " + json.dumps(v) + ");"
        for k, v in prefs.items()
    )
)
background = (assets / "background.js").read_text().replace("__PORT__", str(port))
manifest = {
    "manifest_version": 2,
    "name": "Draft Reopen Investigation",
    "version": "0.0.1",
    "browser_specific_settings": {
        "gecko": {
            "id": "draft-reopen-probe@example.invalid",
            "strict_min_version": "128.0",
        }
    },
    "permissions": [
        "accountsRead",
        "accountsIdentities",
        "compose",
        "compose.save",
        "messagesRead",
        "messagesImport",
        "http://127.0.0.1/*",
    ],
    "background": {"scripts": ["background.js"]},
}
(profile / "extensions").mkdir(exist_ok=True)
with zipfile.ZipFile(
    profile / "extensions" / "draft-reopen-probe@example.invalid.xpi", "w"
) as z:
    z.writestr("manifest.json", json.dumps(manifest))
    z.writestr("background.js", background)
log = (root / "thunderbird.log").open("w")
env = {k: v for k, v in os.environ.items() if k in ("HOME", "USER", "LOGNAME", "LANG")}
env.update(
    PATH="/usr/bin:/bin",
    MOZ_ENABLE_WAYLAND="0",
    GDK_BACKEND="x11",
    MOZ_CRASHREPORTER_DISABLE="1",
)
proc = subprocess.Popen(
    ["xvfb-run", "-a", thunderbird, "-no-remote", "-profile", str(profile)],
    stdout=log,
    stderr=log,
    env=env,
    start_new_session=True,
)
try:
    for _ in range(90):
        if results and results[-1].get("step") in ("done", "error"):
            break
        if proc.poll() is not None:
            break
        time.sleep(1)
finally:
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
    server.shutdown()
    (root / "results.json").write_text(json.dumps(results, indent=2))
print("RESULTS", root / "results.json", flush=True)

if not results or results[-1].get("step") != "done":
    raise SystemExit(
        "Probe did not complete. Check results.json and thunderbird.log in the artifacts directory."
    )
comparisons = [row for row in results if row["step"] == "comparison"]
assert len(comparisons) == 2, "Expected both HTML and plain-text scenarios"
for row in comparisons:
    before, after = row["before"], row["after"]
    assert after["identityId"] == row["wantedIdentityId"], row["scenario"]
    assert after["identityId"] != before["identityId"], row["scenario"]
    for key in (
        "subject",
        "to",
        "cc",
        "bcc",
        "isPlainText",
        "replyTo",
        "returnReceipt",
        "deliveryStatusNotification",
        "customHeaders",
    ):
        assert before.get(key) == after.get(key), (row["scenario"], key)
    for key in ("references", "in-reply-to", "x-probe"):
        assert row["beforeHeaders"][key] == row["afterHeaders"][key], (
            row["scenario"],
            key,
        )
    assert row["attachments"][0]["text"] == "Attachment text: café\n"
    assert row["beforeFiles"] == row["afterFiles"], (
        row["scenario"],
        "MIME attachment bytes",
    )
    if before["isPlainText"]:
        assert "Edited plain reply marker" in after["plainTextBody"]
    else:
        assert "<b>Edited reply marker</b>" in after["body"]
        assert "probe-image" in after["body"]
        assert any(file["contentType"] == "image/png" for file in row["afterFiles"])
    assert "Quoted original marker" in (
        after.get("body", "") + after.get("plainTextBody", "")
    )
    print("PASS:", row["scenario"])
