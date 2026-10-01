"use strict";

const tabId = Number(new URLSearchParams(location.search).get("tab"));
const explanation = document.getElementById("explanation");
const choice = document.getElementById("choice");
const alias = document.getElementById("alias");
const account = document.getElementById("account");
const status = document.getElementById("status");
const apply = document.getElementById("apply");

function showError(message) {
  status.textContent = message;
  status.hidden = false;
}

async function load() {
  if (!Number.isInteger(tabId)) {
    showError("The reply window could not be identified.");
    return;
  }
  const context = await messenger.runtime.sendMessage({ type: "prompt.get", tabId });
  if (!context) {
    explanation.textContent = "This alert is no longer needed.";
    return;
  }
  if (context.error) {
    explanation.textContent = "The reply could not be checked.";
    showError(context.error);
    return;
  }
  explanation.textContent = context.candidates.length === 1
    ? `This message was sent to ${context.candidates[0].email}, but the reply is set to ${context.currentEmail || "another address"}.`
    : "This message reached more than one of your aliases. Choose the address you want to reply from.";
  for (const candidate of context.candidates) {
    const option = document.createElement("option");
    option.value = candidate.email;
    option.textContent = candidate.email + (candidate.identityId ? " (identity exists)" : " (new identity)");
    alias.append(option);
  }
  choice.hidden = false;
  apply.hidden = !context.accountId;
  updateButton(context);
  alias.addEventListener("change", () => updateButton(context));
}

function updateButton(context) {
  const selected = context.candidates.find(candidate => candidate.email === alias.value);
  apply.textContent = selected?.identityId ? "Use this identity" : "Create identity and use it";
  account.textContent = !context.accountName
    ? "No mail account was found. Check your account settings."
    : selected?.identityId
      ? "This identity is already configured in Thunderbird."
      : `The identity will be added to ${context.accountName}. Your default name and organisation will be copied.`;
}

apply.addEventListener("click", async () => {
  apply.disabled = true;
  status.hidden = true;
  try {
    await messenger.runtime.sendMessage({ type: "prompt.apply", tabId, email: alias.value });
    window.close();
  } catch (error) {
    showError(error.message || String(error));
    apply.disabled = false;
  }
});
document.getElementById("dismiss").addEventListener("click", () => window.close());
load().catch(error => showError(error.message || String(error)));
