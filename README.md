# Alias Reply Guard

A Thunderbird 128+ add-on for people who use a different address for each service.

## What it does

When you open a reply, the add-on checks the original message's To, Cc, and Bcc recipients for an address at `example-domain.com`. If no recipient reveals the alias, it also checks common delivery headers such as `Delivered-To` and `X-Original-To`.

- If the matching identity already exists, the add-on selects it in the reply.
- If the identity does not exist, an alert offers **Create identity and use it**. That click permanently adds the identity to your mail account and selects it in the open reply. You can then write or review your reply and send it normally.
- If you try to send with the wrong identity, the send is cancelled and the alert opens. After choosing an identity, click Send again.
- If a message was sent to multiple aliases, the alert asks you to choose one.

The new identity copies the account's default **name**, **organisation**, and **compose format**. It deliberately does not copy the default Reply-To address or signature, as either might contain the private default address.

## Install

In Thunderbird, open **Add-ons and Themes** → the gear menu → **Install Add-on From File…**, then select `alias-reply-guard.xpi`. The initial protected domain is the placeholder `example-domain.com`. Before using the add-on, open its **Preferences** in Add-ons and Themes and replace this with your own domain.

## Scope and limitations

The add-on checks replies to messages that Thunderbird can read through its message API. It cannot infer an alias if the original message contains no matching recipient or delivery header, such as some blind copies or forwarded mail. Replies to an `.eml` file opened outside Thunderbird's message store may not expose an original message ID. A reply saved as a draft and later reopened is outside the automatic check, so choose the identity before saving that draft. The add-on does not send mail on your behalf; it leaves the final Send action to you. Your SMTP server must allow sending from the alias addresses.

## Development

The add-on uses MailExtension APIs plus a small Thunderbird Experiment API to refresh the From menu when an identity is created after a reply window opens. This lets the new identity be selected in the same window without reopening the reply. Because Experiment APIs access Thunderbird internals, Thunderbird requests **full, unrestricted access to Thunderbird and your computer** when installing this version. The helper only rebuilds the identity menu; it does not read or write files or make network requests.

The add-on needs no network service. Development commands require `just`, Node.js, and `zip`.

```sh
just          # List available commands
just venv     # Create the local Python environment using uv
just test     # Run logic and mocked workflow checks
just package  # Run tests and build dist/alias-reply-guard.xpi
just clean    # Remove the generated XPI
```

Python environment management requires `uv`. Run `just venv` to create `.venv/`, then `source .venv/bin/activate` to activate it in Bash. The command preserves existing packages when run again. The extension currently has no Python dependencies; its tests use Node.js and packaging uses `zip`, so neither command requires activating the Python environment.

The package contains only the files in `core-extension-source-files/`, with `manifest.json` at the archive root. Install `dist/alias-reply-guard.xpi` using Thunderbird's **Install Add-on From File…** command. Each build replaces the previous XPI so removed source files cannot remain in the archive.

To run the checks without `just`, use `node test/test.js`.


## Draft reopening investigation

A separate probe tests a potential replacement for the Experiment API. Run `just investigate-drafts` on Linux with `uv`, Thunderbird, and `xvfb-run` installed. It creates a fresh temporary Thunderbird profile containing only synthetic local mail, loads a test extension using public APIs, and checks an HTML reply-all and a plain-text reply. It never calls a send API. The command prints the directory containing the profile, Thunderbird log, and full JSON results. The probe is outside the packaged extension and does not change the add-on's current behavior.

Verified on Thunderbird **128.12.0esr** on 1 October 2026:

- Creating an identity after opening a reply reproduces the stale From menu.
- Saving with `compose.saveMessage` and loading the saved message with `compose.beginNew` creates a fresh identity menu. Selecting the new identity then succeeds.
- Subject, To/Cc/Bcc, Reply-To, body markers and formatting, ordinary attachment bytes, inline PNG bytes, and both `References` and `In-Reply-To` survive the tested round trip.
- Reopen with the saved identity and original `isPlainText` value, then select the new identity. Passing the new identity directly while reopening changed the plain-text case to HTML in this version.
- Edit As New drops custom headers and resets return-receipt and delivery-status settings. Explicitly restoring them after selecting the new identity preserves the tested values.
- The resulting compose window has type `new` and references the saved draft, not the original incoming message. An implementation must carry the original reply context into that window so the send guard continues to work.
- Edit As New leaves the saved draft behind. A production implementation needs a deliberate backup/cleanup policy and must retain the original reply if saving, reopening, or verification fails.

The findings support using a saved draft instead of manually reconstructing the body and attachments. They do not yet establish compatibility with newer Thunderbird versions, IMAP drafts, encryption/signing, cloud attachments, signature changes, other extensions, or every compose setting. Those cases and the send-guard integration still need testing before replacing the current Experiment API.
