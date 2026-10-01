"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const core = require("../core-extension-source-files/core.js");

function event() {
  return { listener: null, addListener(fn) { this.listener = fn; } };
}

function fixture({ existing = false, recipients = ["Shop <shop@example-domain.com>"],
  refreshError = false, selectionBlocked = false } = {}) {
  const events = {
    tabCreated: event(), tabUpdated: event(), tabRemoved: event(), windowCreated: event(), windowRemoved: event(),
    beforeSend: event(), message: event()
  };
  const base = { id: "id-default", accountId: "account-1", email: "private@example-domain.com",
    name: "Nick Askew", organization: "Example Ltd", composeHtml: true,
    replyTo: "private@example-domain.com", signature: "My private address" };
  const identities = [base];
  if (existing) identities.push({ id: "id-shop", accountId: "account-1", email: "shop@example-domain.com" });
  // Thunderbird snapshots the From menu when the compose window opens.
  const visibleIdentities = new Set(identities.map(identity => identity.id));
  const details = { type: "reply", relatedMessageId: 42, identityId: "id-default",
    subject: "Re: Shop", body: "<p>My reply in progress</p>", to: ["support@example.com"] };
  const calls = { created: [], popups: [], selected: [], refreshed: [] };
  const messenger = {
    storage: { local: { get: async () => ({}), set: async () => {} } },
    runtime: { getURL: path => path, onMessage: events.message },
    tabs: {
      onCreated: events.tabCreated, onUpdated: events.tabUpdated, onRemoved: events.tabRemoved,
      query: async () => [], get: async () => ({ id: 7, windowId: 70 })
    },
    windows: {
      onCreated: events.windowCreated, onRemoved: events.windowRemoved,
      create: async options => { calls.popups.push(options); return { id: 80 + calls.popups.length }; },
      remove: async () => {}, update: async () => {}
    },
    compose: {
      onBeforeSend: events.beforeSend,
      getComposeDetails: async () => ({ ...details }),
      setComposeDetails: async (_, change) => {
        calls.selected.push(change.identityId);
        if (visibleIdentities.has(change.identityId) && !selectionBlocked) Object.assign(details, change);
      }
    },
    aliasReplyGuardCompose: {
      refreshIdentityList: async (tabId, identityId) => {
        calls.refreshed.push({ tabId, identityId });
        if (refreshError) throw new Error("Could not refresh the From menu.");
        for (const identity of identities) visibleIdentities.add(identity.id);
      }
    },
    messages: {
      get: async () => ({ recipients, ccList: [], folder: { accountId: "account-1" } }),
      getFull: async () => ({ headers: {} })
    },
    accounts: { list: async () => [{ id: "account-1", name: "Nick mail", identities }] },
    identities: {
      get: async id => identities.find(item => item.id === id),
      getDefault: async () => base,
      list: async () => [...identities],
      create: async (accountId, data) => {
        calls.created.push({ accountId, data });
        const identity = { id: "id-new", accountId, ...data };
        identities.push(identity);
        return identity;
      }
    }
  };
  vm.runInNewContext(fs.readFileSync(`${__dirname}/../core-extension-source-files/background.js`, "utf8"), {
    messenger, AliasGuardCore: core, console, setTimeout
  });
  return { events, details, calls };
}

async function flush() {
  await new Promise(resolve => setTimeout(resolve, 20));
}

async function checkIdentityMenuRefresh() {
  const item = key => ({ getAttribute: name => name === "identitykey" ? key : null });
  const menu = { children: [item("id-default")], replaceChildren() { this.children = []; } };
  const identityList = {
    menupopup: menu, value: "Custom From <custom@example.com>",
    set selectedItem(selected) {
      this.selected = selected;
      this.value = selected?.getAttribute("identitykey") || "";
    }
  };
  const calls = { rebuilt: 0, invalidated: 0 };
  let available = ["id-default", "id-new"];
  const composeWindow = {
    document: { getElementById: id => id === "msgIdentity" ? identityList : null },
    getCurrentIdentityKey: () => "id-default",
    FillIdentityList: list => {
      calls.rebuilt++;
      list.menupopup.children.push(...available.map(item));
    },
    LoadIdentity: () => assert.fail("Refreshing must not reload signatures or alter the message")
  };
  const sandbox = {
    ExtensionCommon: { ExtensionAPI: class {} },
    Services: { obs: { notifyObservers: (_, topic) => {
      assert.equal(topic, "startupcache-invalidate");
      calls.invalidated++;
    } } }
  };
  vm.runInNewContext(fs.readFileSync(
    `${__dirname}/../core-extension-source-files/api/aliasReplyGuardCompose/implementation.js`, "utf8"
  ), sandbox);
  const experiment = new sandbox.aliasReplyGuardCompose();
  const api = experiment.getAPI({ extension: { tabManager: {
    get: tabId => ({ type: tabId === 7 ? "messageCompose" : "mail", nativeTab: composeWindow })
  } } }).aliasReplyGuardCompose;
  await api.refreshIdentityList(7, "id-new");
  assert.equal(calls.rebuilt, 1);
  assert.deepEqual(menu.children.map(entry => entry.getAttribute("identitykey")), ["id-default", "id-new"]);
  assert.equal(identityList.selected.getAttribute("identitykey"), "id-default");
  assert.equal(identityList.value, "Custom From <custom@example.com>");
  await api.refreshIdentityList(7, "id-new");
  assert.equal(calls.rebuilt, 1, "An identity already in the menu needs no refresh");
  await assert.rejects(api.refreshIdentityList(8, "id-new"), /not a reply window/);
  available = ["id-default", "id-new", "id-other"];
  await api.refreshIdentityList(7, "id-other");
  assert.equal(calls.rebuilt, 2, "Also refresh identities created by another open reply");
  await assert.rejects(api.refreshIdentityList(7, "missing"), /missing from Thunderbird/);
  assert.equal(identityList.value, "Custom From <custom@example.com>");
  experiment.onShutdown(true);
  assert.equal(calls.invalidated, 0);
  experiment.onShutdown(false);
  assert.equal(calls.invalidated, 1);
}

async function main() {
  await checkIdentityMenuRefresh();
  assert.deepEqual(core.replyAddresses(
    { recipients: ["Shop <shop@example-domain.com>"], ccList: [] },
    {}, ["example-domain.com"]
  ).addresses, ["shop@example-domain.com"]);
  assert.deepEqual(core.replyAddresses(
    { recipients: ['"shop@example-domain.com" <other@example.com>'], ccList: [] },
    {}, ["example-domain.com"]
  ).addresses, []);
  assert.deepEqual(core.replyAddresses(
    { recipients: [], ccList: [] }, { "Delivered-To": ["shop@example-domain.com"] }, ["example-domain.com"]
  ).addresses, ["shop@example-domain.com"]);
  assert.deepEqual(core.replyAddresses(
    { recipients: ["a@example-domain.com", "b@example-domain.com"] }, {}, ["example-domain.com"]
  ).addresses, ["a@example-domain.com", "b@example-domain.com"]);

  const fresh = fixture();
  assert.equal((await fresh.events.beforeSend.listener({ id: 7 }, fresh.details)).cancel, true);
  assert.equal(fresh.calls.popups.length, 1);
  const prompt = await fresh.events.message.listener({ type: "prompt.get", tabId: 7 });
  assert.equal(prompt.candidates[0].email, "shop@example-domain.com");
  await fresh.events.message.listener({ type: "prompt.apply", tabId: 7, email: "shop@example-domain.com" });
  assert.equal(fresh.calls.created.length, 1);
  assert.equal(fresh.calls.created[0].data.name, "Nick Askew");
  assert.equal(fresh.calls.created[0].data.organization, "Example Ltd");
  assert.equal(fresh.calls.created[0].data.replyTo, undefined);
  assert.equal(fresh.calls.created[0].data.signature, undefined);
  assert.equal(fresh.details.identityId, "id-new");
  assert.deepEqual(fresh.calls.refreshed, [{ tabId: 7, identityId: "id-new" }]);
  assert.equal(fresh.details.body, "<p>My reply in progress</p>");
  assert.equal(fresh.details.subject, "Re: Shop");
  assert.deepEqual(fresh.details.to, ["support@example.com"]);
  assert.equal((await fresh.events.beforeSend.listener({ id: 7 }, fresh.details)).cancel, undefined);

  for (const failure of [{ refreshError: true }, { selectionBlocked: true }]) {
    const failed = fixture(failure);
    await failed.events.beforeSend.listener({ id: 7 }, failed.details);
    await assert.rejects(failed.events.message.listener({
      type: "prompt.apply", tabId: 7, email: "shop@example-domain.com"
    }), failure.refreshError ? /Could not refresh/ : /did not select/);
    assert.equal(failed.details.identityId, "id-default");
    assert.ok(await failed.events.message.listener({ type: "prompt.get", tabId: 7 }));
    assert.equal((await failed.events.beforeSend.listener({ id: 7 }, failed.details)).cancel, true);
    await assert.rejects(failed.events.message.listener({
      type: "prompt.apply", tabId: 7, email: "shop@example-domain.com"
    }));
    assert.equal(failed.calls.created.length, 1, "Retry must reuse the created identity");
  }

  const known = fixture({ existing: true });
  known.events.tabCreated.listener({ id: 7, type: "messageCompose" });
  await flush();
  assert.deepEqual(known.calls.selected, ["id-shop"]);
  assert.equal(known.calls.popups.length, 0);

  const ambiguous = fixture({ recipients: ["private@example-domain.com", "shop@example-domain.com"] });
  assert.equal((await ambiguous.events.beforeSend.listener({ id: 7 }, ambiguous.details)).cancel, true);
  assert.equal(ambiguous.calls.popups.length, 1);
  console.log("All Alias Reply Guard checks passed.");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
