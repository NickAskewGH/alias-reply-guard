"use strict";

var aliasReplyGuardCompose = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    return {
      aliasReplyGuardCompose: {
        async refreshIdentityList(tabId, identityId) {
          const tab = context.extension.tabManager.get(tabId);
          if (tab.type !== "messageCompose") throw new Error("This tab is not a reply window.");
          const composeWindow = tab.nativeTab;
          const identityList = composeWindow.document.getElementById("msgIdentity");
          if (!identityList?.menupopup || typeof composeWindow.FillIdentityList !== "function") {
            throw new Error("Thunderbird's From menu could not be refreshed.");
          }
          const findItem = key => [...identityList.menupopup.children]
            .find(item => item.getAttribute("identitykey") === key);
          if (findItem(identityId)) return;

          const currentKey = composeWindow.getCurrentIdentityKey();
          const currentValue = identityList.value;
          identityList.menupopup.replaceChildren();
          composeWindow.FillIdentityList(identityList);
          identityList.selectedItem = findItem(currentKey) || null;
          identityList.value = currentValue;

          // Leave selection and signature changes to compose.setComposeDetails.
          // Rebuilding the menu must not overwrite the user's message or From value.
          if (!findItem(identityId)) {
            throw new Error("The requested identity is missing from Thunderbird's From menu.");
          }
        }
      }
    };
  }

  onShutdown(isAppShutdown) {
    if (!isAppShutdown) Services.obs.notifyObservers(null, "startupcache-invalidate", null);
  }
};
