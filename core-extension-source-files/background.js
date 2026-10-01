"use strict";

const DEFAULT_DOMAINS = ["example-domain.com"];
const promptByTab = new Map();
const contextByTab = new Map();
const inspectingTabs = new Set();
const checkedTabs = new Set();
const approvedByTab = new Map();
const creationLocks = new Map();

async function configuredDomains() {
  const stored = await messenger.storage.local.get("domains");
  return AliasGuardCore.normalizeDomains(stored.domains || DEFAULT_DOMAINS);
}

async function inspectReply(tabId, suppliedDetails) {
  const details = suppliedDetails || await messenger.compose.getComposeDetails(tabId);
  if (details.type !== "reply" || !details.relatedMessageId) return null;

  const domains = await configuredDomains();
  const [message, full, accounts] = await Promise.all([
    messenger.messages.get(details.relatedMessageId),
    messenger.messages.getFull(details.relatedMessageId),
    messenger.accounts.list(false)
  ]);
  const result = AliasGuardCore.replyAddresses(message, full.headers, domains);
  if (!result.addresses.length) return null;

  const current = details.identityId ? await messenger.identities.get(details.identityId) : null;
  const folderAccountId = message.folder && message.folder.accountId;
  const allIdentities = accounts.flatMap(account => account.identities || []);
  const sameDomain = identity => domains.some(domain =>
    AliasGuardCore.normalizeEmail(identity.email).endsWith(`@${domain}`));
  const currentAccount = accounts.find(account => account.id === current?.accountId);
  const folderAccount = accounts.find(account => account.id === folderAccountId);
  const account = (currentAccount && currentAccount.identities.some(sameDomain) && currentAccount)
    || (folderAccount && folderAccount.identities.some(sameDomain) && folderAccount)
    || accounts.find(item => item.identities.some(sameDomain))
    || currentAccount || folderAccount;

  const candidates = result.addresses.map(email => {
    const identity = allIdentities.find(item => AliasGuardCore.normalizeEmail(item.email) === email);
    return { email, identityId: identity?.id || null };
  });
  const currentEmail = AliasGuardCore.normalizeEmail(current?.email);
  const matchesCurrent = candidates.some(item => item.email === currentEmail)
    && (candidates.length === 1 || approvedByTab.get(tabId) === currentEmail);

  return {
    tabId,
    accountId: account?.id || null,
    accountName: account?.name || "",
    candidates,
    currentEmail,
    currentIdentityId: details.identityId || null,
    matchesCurrent,
    source: result.source,
    error: null
  };
}

async function openPrompt(context) {
  contextByTab.set(context.tabId, context);
  if (promptByTab.has(context.tabId)) {
    try {
      await messenger.windows.update(promptByTab.get(context.tabId), { focused: true });
      return;
    } catch (_) {
      promptByTab.delete(context.tabId);
    }
  }
  const url = messenger.runtime.getURL(`prompt.html?tab=${context.tabId}`);
  const popup = await messenger.windows.create({ type: "popup", url, width: 510, height: 350 });
  promptByTab.set(context.tabId, popup.id);
}

async function checkNewCompose(tabId) {
  if (inspectingTabs.has(tabId) || checkedTabs.has(tabId)) return;
  inspectingTabs.add(tabId);
  try {
    let details;
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        details = await messenger.compose.getComposeDetails(tabId);
      } catch (_) {
        await new Promise(resolve => setTimeout(resolve, 250));
        continue;
      }
      if (details.type === "reply" && details.relatedMessageId) break;
      if (details.type && details.type !== "reply") {
        checkedTabs.add(tabId);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!details || details.type !== "reply" || !details.relatedMessageId) return;
    const context = await inspectReply(tabId, details);
    checkedTabs.add(tabId);
    if (!context || context.matchesCurrent) return;
    if (context.candidates.length === 1 && context.candidates[0].identityId) {
      await selectIdentity(tabId, context.candidates[0].identityId);
      return;
    }
    await openPrompt(context);
  } catch (error) {
    console.error("Alias Reply Guard could not inspect the reply:", error);
  } finally {
    inspectingTabs.delete(tabId);
  }
}

async function beforeSend(tab, details) {
  try {
    const context = await inspectReply(tab.id, details);
    if (!context || context.matchesCurrent) return {};
    await openPrompt(context);
    return { cancel: true };
  } catch (error) {
    console.error("Alias Reply Guard cancelled a send it could not inspect:", error);
    try {
      await openPrompt({ tabId: tab.id, candidates: [], error:
        "The original message could not be checked. Sending was stopped so the From address can be reviewed. " + error.message });
    } catch (popupError) {
      console.error("Alias Reply Guard could not show its warning:", popupError);
    }
    return { cancel: true };
  }
}

async function createOrFindIdentity(accountId, email) {
  const key = `${accountId}:${email}`;
  if (creationLocks.has(key)) return creationLocks.get(key);
  const work = (async () => {
    const identities = await messenger.identities.list();
    const existing = identities.find(identity => AliasGuardCore.normalizeEmail(identity.email) === email);
    if (existing) return existing;
    const template = await messenger.identities.getDefault(accountId);
    if (!template) throw new Error("No default identity exists for the selected account.");
    return messenger.identities.create(accountId, AliasGuardCore.templateDetails(template, email));
  })();
  creationLocks.set(key, work);
  try {
    return await work;
  } finally {
    creationLocks.delete(key);
  }
}

async function applyChoice(tabId, email) {
  const context = await inspectReply(tabId);
  if (!context || !context.candidates.some(item => item.email === email)) {
    throw new Error("This reply changed. Close this alert and try again.");
  }
  if (!context.accountId) throw new Error("No mail account for this alias could be found.");
  const identity = await createOrFindIdentity(context.accountId, email);
  await selectIdentity(tabId, identity.id);
  approvedByTab.set(tabId, email);
  contextByTab.delete(tabId);
  promptByTab.delete(tabId);
  const composeTab = await messenger.tabs.get(tabId);
  setTimeout(() => {
    messenger.windows.update(composeTab.windowId, { focused: true }).catch(() => {});
  }, 100);
  return { email: identity.email, created: !context.candidates.find(item => item.email === email)?.identityId };
}

async function selectIdentity(tabId, identityId) {
  // identities.create updates the account, but not an already open From menu.
  // Refresh only when this identity is absent, including in other open replies.
  await messenger.aliasReplyGuardCompose.refreshIdentityList(tabId, identityId);
  await messenger.compose.setComposeDetails(tabId, { identityId });
  const verified = await messenger.compose.getComposeDetails(tabId);
  if (verified.identityId !== identityId) throw new Error("Thunderbird did not select the new identity.");
}

messenger.tabs.onCreated.addListener(tab => {
  if (tab.type === "messageCompose") checkNewCompose(tab.id);
});
messenger.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.type === "messageCompose" && changeInfo.status === "complete") checkNewCompose(tabId);
});
messenger.windows.onCreated.addListener(window => {
  if (window.type !== "messageCompose") return;
  messenger.tabs.query({ windowId: window.id }).then(tabs => {
    for (const tab of tabs) if (tab.type === "messageCompose") checkNewCompose(tab.id);
  }).catch(error => console.error("Alias Reply Guard could not inspect a new compose window:", error));
});
messenger.tabs.onRemoved.addListener(tabId => {
  checkedTabs.delete(tabId);
  approvedByTab.delete(tabId);
  contextByTab.delete(tabId);
  const popupId = promptByTab.get(tabId);
  promptByTab.delete(tabId);
  if (popupId) messenger.windows.remove(popupId).catch(() => {});
});
messenger.windows.onRemoved.addListener(windowId => {
  for (const [tabId, popupId] of promptByTab) {
    if (popupId === windowId) promptByTab.delete(tabId);
  }
});
messenger.compose.onBeforeSend.addListener(beforeSend);
messenger.runtime.onMessage.addListener(async message => {
  if (message?.type === "prompt.get") return contextByTab.get(message.tabId) || null;
  if (message?.type === "prompt.apply") return applyChoice(message.tabId, message.email);
  return null;
});

messenger.tabs.query({}).then(tabs => {
  for (const tab of tabs) if (tab.type === "messageCompose") checkNewCompose(tab.id);
}).catch(error => console.error("Alias Reply Guard startup check failed:", error));
