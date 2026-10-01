"use strict";

// Standalone probe extension: only synthetic local mail; no send permission.
async function report(step, data = {}) {
  await fetch("http://127.0.0.1:__PORT__/", {
    method: "POST", body: JSON.stringify({ step, ...data })
  });
}

async function attachmentBytes(messageId) {
  const files = [];
  for (const attachment of await messenger.messages.listAttachments(messageId)) {
    const file = await messenger.messages.getAttachmentFile(messageId, attachment.partName);
    files.push({ name: attachment.name, contentType: attachment.contentType,
      bytes: Array.from(new Uint8Array(await file.arrayBuffer())) });
  }
  return files;
}

async function main() {
  await report("started");
  await new Promise(resolve => setTimeout(resolve, 3000));
  const accounts = await messenger.accounts.list();
  await report("accounts", { accounts });
  const account = accounts.find(item => item.id === "account1");
  const inbox = account.folders.find(folder => folder.name === "Inbox");
  const scenarios = [
    { name: "html-reply-all", plain: false, replyType: "replyToAll" },
    { name: "plain-reply-sender", plain: true, replyType: "replyToSender" }
  ];
  for (const scenario of scenarios) {
    const source = [
      "From: Sender <sender@example.org>", "To: Shop <shop@example-domain.com>",
      "Cc: Other <other@example.org>", "Subject: Draft probe",
      `Message-ID: <${scenario.name}@example.org>`, "Date: Thu, 1 Oct 2026 10:00:00 +0100",
      "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "", "Original message.", ""
    ].join("\r\n");
    const original = await messenger.messages.import(
      new File([source], `${scenario.name}.eml`, { type: "message/rfc822" }), inbox
    );
    const tab = await messenger.compose.beginReply(original.id, scenario.replyType, {
      identityId: "id1", isPlainText: scenario.plain
    });
    const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
    await messenger.compose.setComposeDetails(tab.id, {
      subject: "Re: Edited draft probe", to: ["sender@example.org"],
      cc: ["other@example.org"], bcc: ["hidden@example.org"],
      ...(scenario.plain
        ? { plainTextBody: "Edited plain reply marker\n> Quoted original marker" }
        : { body: `<p><b>Edited reply marker</b></p><img alt="probe-image" src="data:image/png;base64,${image}"><blockquote>Quoted original marker</blockquote>` }),
      returnReceipt: true, deliveryStatusNotification: true, replyTo: ["reply-here@example.org"],
      customHeaders: [{ name: "X-Probe", value: "draft-round-trip" }]
    });
    await messenger.compose.addAttachment(tab.id, {
      file: new File(["Attachment text: café\n"], "probe attachment.txt", { type: "text/plain" })
    });
    const before = await messenger.compose.getComposeDetails(tab.id);
    const identity = await messenger.identities.create(account.id, {
      email: `${scenario.name}@example-domain.com`, name: "Probe User", composeHtml: !scenario.plain
    });
    await messenger.compose.setComposeDetails(tab.id, { identityId: identity.id });
    const attempted = await messenger.compose.getComposeDetails(tab.id);
    await report("stale-menu", { wanted: identity.id, actual: attempted.identityId });

    const saved = await messenger.compose.saveMessage(tab.id, { mode: "draft" });
    await report("saved", { saved });
    const draft = saved.messages[0];
    const beforeFiles = await attachmentBytes(draft.id);
    const fullBefore = await messenger.messages.getFull(draft.id);

    // Use the saved identity while loading: TB 128 chooses the draft's saved
    // identity internally, which can otherwise change a plain-text draft to HTML.
    const reopened = await messenger.compose.beginNew(draft.id, {
      identityId: before.identityId, isPlainText: before.isPlainText
    });
    // The new window has a fresh identity menu. Edit As New resets these extra
    // fields, so explicitly restore them after switching identity.
    await messenger.compose.setComposeDetails(reopened.id, {
      identityId: identity.id, customHeaders: before.customHeaders,
      returnReceipt: before.returnReceipt, deliveryStatusNotification: before.deliveryStatusNotification
    });
    const after = await messenger.compose.getComposeDetails(reopened.id);
    const files = [];
    for (const attachment of await messenger.compose.listAttachments(reopened.id)) {
      const file = await messenger.compose.getAttachmentFile(attachment.id);
      files.push({ name: attachment.name, size: file.size, text: await file.text() });
    }
    const savedAgain = await messenger.compose.saveMessage(reopened.id, { mode: "draft" });
    const afterFiles = await attachmentBytes(savedAgain.messages[0].id);
    const fullAfter = await messenger.messages.getFull(savedAgain.messages[0].id);
    await report("comparison", {
      scenario: scenario.name, wantedIdentityId: identity.id, beforeFiles, afterFiles,
      before, after, attachments: files, beforeHeaders: fullBefore.headers,
      afterHeaders: fullAfter.headers, beforeParts: fullBefore.parts, afterParts: fullAfter.parts
    });
    await messenger.tabs.remove(tab.id);
    await messenger.tabs.remove(reopened.id);
  }
  await report("done");
}

main().catch(error => report("error", { message: error.message, stack: error.stack }));
