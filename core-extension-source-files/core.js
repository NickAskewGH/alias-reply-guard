"use strict";

const AliasGuardCore = (() => {
  const ADDRESS = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const DELIVERY_HEADERS = [
    "delivered-to", "x-original-to", "envelope-to", "x-envelope-to", "x-forwarded-to"
  ];

  function normalizeDomains(value) {
    const entries = Array.isArray(value) ? value : String(value || "").split(/[\s,;]+/);
    return [...new Set(entries.map(entry => entry.trim().toLowerCase().replace(/^@/, ""))
      .filter(entry => /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(entry) && entry.includes(".")))];
  }

  function normalizeEmail(value) {
    return String(value || "").trim().toLowerCase();
  }

  function findAddresses(values, domains) {
    const allowed = new Set(normalizeDomains(domains));
    const found = new Set();
    for (const value of values || []) {
      const text = String(value);
      const bracketed = [...text.matchAll(/<([^<>]+)>/g)];
      const mailboxes = bracketed.length ? bracketed.map(match => match[1]) : [text];
      for (const mailbox of mailboxes) {
        for (const match of mailbox.matchAll(ADDRESS)) {
          const email = normalizeEmail(match[0]);
          if (allowed.has(email.split("@").at(-1))) found.add(email);
        }
      }
    }
    return [...found];
  }

  function headerValues(headers, name) {
    if (!headers) return [];
    const key = Object.keys(headers).find(item => item.toLowerCase() === name);
    return key ? headers[key] || [] : [];
  }

  function replyAddresses(message, headers, domains) {
    const visible = findAddresses([
      ...(message.recipients || []), ...(message.ccList || []), ...(message.bccList || [])
    ], domains);
    if (visible.length) return { addresses: visible, source: "To/Cc" };
    const delivery = findAddresses(DELIVERY_HEADERS.flatMap(name => headerValues(headers, name)), domains);
    if (delivery.length) return { addresses: delivery, source: "delivery headers" };
    return { addresses: [], source: "none" };
  }

  function templateDetails(template, email) {
    const details = { email };
    for (const property of ["name", "organization", "composeHtml"]) {
      if (template && template[property] !== undefined) details[property] = template[property];
    }
    return details;
  }

  return { normalizeDomains, normalizeEmail, replyAddresses, templateDetails };
})();

if (typeof module !== "undefined") module.exports = AliasGuardCore;
