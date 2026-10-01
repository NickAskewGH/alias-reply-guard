"use strict";

const domains = document.getElementById("domains");
const status = document.getElementById("status");

messenger.storage.local.get("domains").then(saved => {
  domains.value = (saved.domains || ["example-domain.com"]).join("\n");
});

document.getElementById("save").addEventListener("click", async () => {
  const parsed = AliasGuardCore.normalizeDomains(domains.value);
  status.hidden = false;
  if (!parsed.length) {
    status.textContent = "Enter at least one valid domain.";
    return;
  }
  await messenger.storage.local.set({ domains: parsed });
  domains.value = parsed.join("\n");
  status.textContent = "Saved.";
});
